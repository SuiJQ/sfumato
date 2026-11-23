/// <reference lib="webworker" />
/**
 * 分析 Worker（常驻）。
 *
 * 产出两张图：
 *   mask：R 人像 / G 皮肤 / B 天空 / A 绿植
 *   eyes：R 眼睛（其余通道未用）
 *
 * 模型不可用时自动退化为纯启发式——功能不中断，只是没有精确人像。
 */

import * as ort from 'onnxruntime-web/wasm';
import type { AnalyzeInit, AnalyzeRequest, AnalyzeResult, FacePolygons, MaskPayload } from '../shared/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const ANALYSIS_LONG_SIDE = 384;
const MASK_LONG_SIDE = 512;

let wasmBase = './ort/';
let modelUrl = './models/modnet_int8.onnx';
let sessionPromise: Promise<ort.InferenceSession> | null = null;
let sessionFailed = false;

function post(result: AnalyzeResult, transfer: Transferable[] = []): void {
  ctx.postMessage(result, transfer);
}

async function getSession(): Promise<ort.InferenceSession | null> {
  if (sessionFailed) return null;
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = wasmBase;
    ort.env.wasm.numThreads = 1; // 无 COOP/COEP 时多线程不可用，显式收紧
    ort.env.wasm.simd = true;
    sessionPromise = ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }
  try {
    return await sessionPromise;
  } catch (err) {
    sessionFailed = true;
    sessionPromise = null;
    console.warn('[analyze] 模型加载失败，退回启发式:', err);
    return null;
  }
}

function resized(w: number, h: number, longSide: number): [number, number] {
  const scale = Math.min(1, longSide / Math.max(w, h));
  return [
    Math.max(32, Math.round((w * scale) / 32) * 32),
    Math.max(32, Math.round((h * scale) / 32) * 32),
  ];
}

async function portraitAlpha(bitmap: ImageBitmap): Promise<Float32Array | null> {
  const session = await getSession();
  if (!session) return null;

  const [w, h] = resized(bitmap.width, bitmap.height, ANALYSIS_LONG_SIDE);
  const canvas = new OffscreenCanvas(w, h);
  const c2d = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!c2d) return null;
  c2d.drawImage(bitmap, 0, 0, w, h);
  const px = c2d.getImageData(0, 0, w, h).data;

  const plane = w * h;
  const input = new Float32Array(plane * 3);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    input[i] = (px[p] / 255 - 0.5) / 0.5;
    input[plane + i] = (px[p + 1] / 255 - 0.5) / 0.5;
    input[plane * 2 + i] = (px[p + 2] / 255 - 0.5) / 0.5;
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, h, w]);
  const feeds: Record<string, ort.Tensor> = {};
  feeds[session.inputNames[0] ?? 'input'] = tensor;
  const out = await session.run(feeds);
  const raw = out[session.outputNames[0] ?? 'output']?.data as Float32Array | undefined;
  if (!raw) return null;

  // 若输出是 logits，补一个 sigmoid
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] < min) min = raw[i];
    if (raw[i] > max) max = raw[i];
  }
  const alpha = new Float32Array(raw.length);
  if (min < -0.05 || max > 1.05) {
    for (let i = 0; i < raw.length; i++) alpha[i] = 1 / (1 + Math.exp(-raw[i]));
  } else {
    alpha.set(raw);
  }
  return alpha;
}

/** 可分离盒式模糊，软化 mask 边缘 */
function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const win = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / win;
      acc += src[y * w + Math.min(w - 1, x + radius + 1)] - src[y * w + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      acc += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
    }
  }
  return out;
}

/** 把归一化多边形栅格化成软权重图 */
function rasterize(polygons: [number, number][][], w: number, h: number, blur: number): Float32Array {
  const canvas = new OffscreenCanvas(w, h);
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  const out = new Float32Array(w * h);
  if (!c2d) return out;

  c2d.fillStyle = '#000';
  c2d.fillRect(0, 0, w, h);
  c2d.fillStyle = '#fff';
  for (const poly of polygons) {
    if (poly.length < 3) continue;
    c2d.beginPath();
    poly.forEach(([x, y], i) => {
      const px = Math.max(0, Math.min(1, x)) * w;
      const py = Math.max(0, Math.min(1, y)) * h;
      if (i === 0) c2d.moveTo(px, py);
      else c2d.lineTo(px, py);
    });
    c2d.closePath();
    c2d.fill();
  }
  const px = c2d.getImageData(0, 0, w, h).data;
  for (let i = 0; i < w * h; i++) out[i] = px[i * 4] / 255;
  return blur > 0 ? boxBlur(out, w, h, blur) : out;
}

/** 归一化到峰值为 1，让眼神光强度与眼睛在画面中的大小无关 */
function normalizePeak(mask: Float32Array): void {
  let max = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > max) max = mask[i];
  if (max < 1e-3) return;
  for (let i = 0; i < mask.length; i++) mask[i] /= max;
}

/** 把脸廓略微外扩，避免模糊后下巴被削掉 */
function expand(poly: [number, number][], k: number): [number, number][] {
  if (poly.length === 0) return poly;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of poly) {
    cx += x;
    cy += y;
  }
  cx /= poly.length;
  cy /= poly.length;
  return poly.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k] as [number, number]);
}

function buildMasks(
  bitmap: ImageBitmap,
  personAlpha: Float32Array | null,
  alphaW: number,
  alphaH: number,
  faces: FacePolygons[],
): MaskPayload {
  const [mw, mh] = resized(bitmap.width, bitmap.height, MASK_LONG_SIDE);
  const canvas = new OffscreenCanvas(mw, mh);
  const c2d = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!c2d) throw new Error('无法创建 mask 画布');
  c2d.drawImage(bitmap, 0, 0, mw, mh);
  const px = c2d.getImageData(0, 0, mw, mh).data;

  const n = mw * mh;
  const person = new Float32Array(n);
  const skin = new Float32Array(n);
  const sky = new Float32Array(n);
  const green = new Float32Array(n);

  const alphaHas = personAlpha !== null;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const i = y * mw + x;
      if (alphaHas) {
        // 双线性重采样：最近邻会让发丝边缘阶梯化，后续 boxBlur 只能掩盖不能修复
        const sx = Math.min(alphaW - 1, Math.max(0, (x / mw) * alphaW - 0.5));
        const sy = Math.min(alphaH - 1, Math.max(0, (y / mh) * alphaH - 0.5));
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(alphaW - 1, x0 + 1);
        const y1 = Math.min(alphaH - 1, y0 + 1);
        const fx = sx - x0;
        const fy = sy - y0;
        const a = personAlpha!;
        person[i] =
          (a[y0 * alphaW + x0] * (1 - fx) + a[y0 * alphaW + x1] * fx) * (1 - fy) +
          (a[y1 * alphaW + x0] * (1 - fx) + a[y1 * alphaW + x1] * fx) * fy;
      }

      const p = i * 4;
      const r = px[p] / 255;
      const g = px[p + 1] / 255;
      const b = px[p + 2] / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const maxc = Math.max(r, g, b);
      const minc = Math.min(r, g, b);
      const sat = maxc <= 0.001 ? 0 : (maxc - minc) / maxc;

      // 皮肤：暖色中性区（R>G>B 且饱和度不过高）
      const skinScore =
        r > 0.25 && r > g && g > b && r - b > 0.05 && r - b < 0.5 && sat > 0.08 && sat < 0.62
          ? 1 - Math.abs(lum - 0.55) * 0.6
          : 0;
      skin[i] = Math.max(0, skinScore) * (alphaHas ? Math.max(person[i], 0.15) : 1);

      // 天空：上部 + 偏蓝或高亮低饱和
      const blueish = b > r + 0.03 && b > 0.32;
      // "亮而低饱和"只在高处才算天空：云海、雾、白色墙面都在地平线以下，
      // 误判进来会被 sky 模块加饱和，整片云被染成紫色（实测）
      const overcast = y / mh < 0.35 && lum > 0.72 && sat < 0.16;
      const upper = 1 - Math.min(1, Math.max(0, (y / mh - 0.45) / 0.25));
      sky[i] = (blueish || overcast ? 1 : 0) * upper * (alphaHas ? 1 - person[i] : 1);

      // 绿植：绿通道明显占优
      green[i] = g > r * 1.08 && g > b * 1.08 && sat > 0.12 ? 1 : 0;
      green[i] *= (alphaHas ? 1 - person[i] : 1) * (1 - sky[i]);
    }
  }

  // FaceMesh：用脸廓收窄肤色权重，用眼睛多边形单独出一条通道
  let eyeMask: Float32Array | null = null;
  if (faces.length > 0) {
    const faceMask = rasterize(
      faces.map((f) => expand(f.oval, 1.06)),
      mw,
      mh,
      3,
    );
    for (let i = 0; i < n; i++) {
      // 脸内权重高、脸外（手/腿）保留基础权重
      skin[i] *= 0.55 + 0.45 * faceMask[i];
    }
    // 眼睛在 512px 的 mask 上只有十几个像素宽，先外扩再归一化峰值，
    // 否则模糊之后权重只剩 0.4，眼神光几乎看不见。
    const eyePolys = faces.flatMap((f) => [expand(f.eyeL, 1.3), expand(f.eyeR, 1.3)]);
    eyeMask = rasterize(eyePolys, mw, mh, 1);
    normalizePeak(eyeMask);
  }

  const personB = alphaHas ? boxBlur(person, mw, mh, 2) : person;
  const skinB = boxBlur(skin, mw, mh, 2);
  const skyB = boxBlur(sky, mw, mh, 4);
  const greenB = boxBlur(green, mw, mh, 3);

  const out = new Uint8ClampedArray(n * 4);
  const eyeOut = new Uint8ClampedArray(n * 4);
  let sumP = 0;
  let sumS = 0;
  let sumK = 0;
  let sumG = 0;
  let hueA = 0;
  let hueB = 0;
  let satSum = 0;
  let skinCount = 0;
  let eyeCount = 0;

  for (let i = 0; i < n; i++) {
    const p = personB[i];
    const s = Math.min(1, skinB[i]);
    const k = Math.min(1, skyB[i]);
    const g = Math.min(1, greenB[i]);
    out[i * 4] = p * 255;
    out[i * 4 + 1] = s * 255;
    out[i * 4 + 2] = k * 255;
    out[i * 4 + 3] = g * 255;
    sumP += p;
    sumS += s;
    sumK += k;
    sumG += g;

    if (eyeMask) {
      const e = Math.min(1, eyeMask[i]) * (alphaHas ? Math.max(0.25, p) : 1);
      eyeOut[i * 4] = e * 255;
      eyeOut[i * 4 + 1] = 0;
      eyeOut[i * 4 + 2] = 0;
      eyeOut[i * 4 + 3] = 255;
      eyeCount += e;
    }

    if (s > 0.5) {
      const q = i * 4;
      const rl = (px[q] / 255) ** 2.2;
      const gl = (px[q + 1] / 255) ** 2.2;
      const bl = (px[q + 2] / 255) ** 2.2;
      const L = Math.cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl);
      const M = Math.cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl);
      const S = Math.cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl);
      const A = 1.9779984951 * L - 2.428592205 * M + 0.4505937099 * S;
      const B2 = 0.0259040371 * L + 0.7827717662 * M - 0.808675766 * S;
      hueA += A;
      hueB += B2;
      satSum += Math.hypot(A, B2);
      skinCount++;
    }
  }

  void eyeCount;

  return {
    width: mw,
    height: mh,
    quality: alphaHas ? 'model' : 'heuristic',
    regions: { person: sumP / n, skin: sumS / n, sky: sumK / n, green: sumG / n },
    skinHue: skinCount ? Math.atan2(hueB, hueA) : 0,
    skinSat: skinCount ? satSum / skinCount : 0,
    faceCount: faces.length,
    pixels: out,
    eyes: eyeOut,
  };
}

ctx.onmessage = async (event: MessageEvent<AnalyzeRequest | AnalyzeInit>) => {
  const msg = event.data;
  if ('t' in msg && msg.t === 'init') {
    wasmBase = msg.wasmBase;
    modelUrl = msg.modelUrl;
    return;
  }

  const req = msg as AnalyzeRequest;
  const started = performance.now();
  try {
    const alpha = await portraitAlpha(req.bitmap).catch((err) => {
      console.warn('[analyze] 推理失败:', err);
      return null;
    });

    let width = ANALYSIS_LONG_SIDE;
    let height = ANALYSIS_LONG_SIDE;
    if (alpha) [width, height] = resized(req.bitmap.width, req.bitmap.height, ANALYSIS_LONG_SIDE);

    const payload = buildMasks(req.bitmap, alpha, width, height, req.faces ?? []);
    const { pixels, eyes, ...meta } = payload;
    const result: AnalyzeResult = {
      ok: true,
      mask: {
        ...meta,
        data: new Uint8Array(pixels.buffer.slice(0)),
        eyeData: new Uint8Array(eyes.buffer.slice(0)),
        ms: Math.round(performance.now() - started),
      },
    };
    const mask = result.mask!;
    post(result, [mask.data.buffer, mask.eyeData.buffer]);
  } catch (err) {
    post({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    req.bitmap.close();
  }
};