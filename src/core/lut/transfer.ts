/**
 * 从参考图"学风格"：按亮度分箱的色彩迁移，烘焙成 33³ LUT。
 *
 * 为什么不是全局协方差白化：两张图的内容常常不同（一张多天空、一张多石墙），
 * 全局均值/协方差会把"内容差异"当成"色调差异"，结果就是荧光色。
 *
 * 按亮度分箱后：
 *   · 亮度先做分位数对齐（解决曝光差异）
 *   · 每个亮度箱单独算色度偏移（解决"高光偏冷、阴影偏暖"这类风格）
 *   · 相邻箱做平滑，避免出现色带
 *
 * 只迁移色调分布，不迁移内容。
 */

import { linearToOklab, linearToSrgb, oklabToLinear, srgbToLinear } from '../color';
import { LUT_SIZE } from './cube';

const BINS = 16;
const MAX_CHROMA = 0.18;

interface Profile {
  /** 每个亮度箱的像素数 */
  count: number[];
  /** 每个亮度箱的色度均值 */
  meanA: number[];
  meanB: number[];
  /** 亮度直方图（用于分位数对齐） */
  luma: number[];
}

function profile(data: ImageData): Profile {
  const px = data.data;
  const n = data.width * data.height;

  const count = new Array<number>(BINS).fill(0);
  const sumA = new Array<number>(BINS).fill(0);
  const sumB = new Array<number>(BINS).fill(0);
  const luma = new Array<number>(BINS).fill(0);

  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (px[p + 3] < 8) continue;
    const r = srgbToLinear(px[p] / 255);
    const g = srgbToLinear(px[p + 1] / 255);
    const b = srgbToLinear(px[p + 2] / 255);
    const [L, A, B] = linearToOklab(r, g, b);
    const bin = Math.min(BINS - 1, Math.max(0, Math.round(L * (BINS - 1))));
    count[bin]++;
    sumA[bin] += A;
    sumB[bin] += B;
    luma[bin]++;
  }

  const meanA = new Array<number>(BINS).fill(0);
  const meanB = new Array<number>(BINS).fill(0);
  for (let i = 0; i < BINS; i++) {
    if (count[i] > 0) {
      meanA[i] = sumA[i] / count[i];
      meanB[i] = sumB[i] / count[i];
    }
  }
  // 空箱用邻居插值填充
  fillGaps(meanA);
  fillGaps(meanB);

  return { count, meanA, meanB, luma };
}

function fillGaps(arr: number[]): void {
  let lastValid = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] !== 0) {
      lastValid = i;
      continue;
    }
    let next = -1;
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[j] !== 0) {
        next = j;
        break;
      }
    }
    if (lastValid >= 0 && next >= 0) {
      const t = (i - lastValid) / (next - lastValid);
      arr[i] = arr[lastValid] + (arr[next] - arr[lastValid]) * t;
    } else if (lastValid >= 0) {
      arr[i] = arr[lastValid];
    } else if (next >= 0) {
      arr[i] = arr[next];
    }
  }
}

function smooth(arr: number[]): number[] {
  const out = arr.slice();
  for (let i = 1; i < arr.length - 1; i++) {
    out[i] = arr[i - 1] * 0.25 + arr[i] * 0.5 + arr[i + 1] * 0.25;
  }
  return out;
}

/** 亮度分位数对齐表：source 的 L → reference 的 L */
function toneAnchors(src: Profile, ref: Profile): { x: number[]; y: number[] } {
  const totalS = src.luma.reduce((a, b) => a + b, 0) || 1;
  const totalR = ref.luma.reduce((a, b) => a + b, 0) || 1;

  const x: number[] = [];
  const y: number[] = [];
  const steps = 9;
  for (let k = 0; k < steps; k++) {
    const q = k / (steps - 1);
    x.push(quantile(src.luma, totalS, q));
    y.push(quantile(ref.luma, totalR, q));
  }
  // 保证单调
  for (let i = 1; i < y.length; i++) {
    if (y[i] < y[i - 1]) y[i] = y[i - 1];
  }
  // 端点固定，避免整体漂移
  x[0] = 0;
  y[0] = 0;
  x[x.length - 1] = 1;
  y[y.length - 1] = 1;
  return { x, y };
}

function quantile(hist: number[], total: number, q: number): number {
  const target = total * q;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return (i + 0.5) / hist.length;
  }
  return 1;
}

function evalAnchors(x: number[], y: number[], v: number): number {
  if (v <= x[0]) return y[0];
  if (v >= x[x.length - 1]) return y[y.length - 1];
  let i = 0;
  while (i < x.length - 2 && v > x[i + 1]) i++;
  const t = (v - x[i]) / Math.max(1e-6, x[i + 1] - x[i]);
  return y[i] + (y[i + 1] - y[i]) * t;
}

/**
 * @param source    当前**渲染结果**的小图（不是原图）
 * @param reference 参考图的小图
 * @param strength  0..1，越低越保守
 */
export function buildLutFromReference(
  source: ImageData,
  reference: ImageData,
  strength = 0.7,
): Uint8Array {
  const sp = profile(source);
  const rp = profile(reference);
  const { x, y } = toneAnchors(sp, rp);

  const dA = smooth(rp.meanA.map((v, i) => clamp(v - sp.meanA[i], -0.06, 0.06)));
  const dB = smooth(rp.meanB.map((v, i) => clamp(v - sp.meanB[i], -0.06, 0.06)));

  const max = LUT_SIZE - 1;
  const out = new Uint8Array(LUT_SIZE ** 3 * 4);
  let o = 0;

  for (let b = 0; b <= max; b++) {
    for (let g = 0; g <= max; g++) {
      for (let r = 0; r <= max; r++) {
        const lab = linearToOklab(
          srgbToLinear(r / max),
          srgbToLinear(g / max),
          srgbToLinear(b / max),
        );

        const L2 = clamp(evalAnchors(x, y, lab[0]), 0, 1);
        const bin = Math.min(BINS - 1, Math.max(0, Math.round(lab[0] * (BINS - 1))));

        // 加性偏移只作用在本来就有颜色的像素上：
        // 否则中性灰会被"推"出一个色相（−45° 直接跳到 +34°），灰阶渐变会分带染色
        const srcChroma = Math.hypot(lab[1], lab[2]);
        const tintable = smoothstep(0.008, 0.05, srcChroma);
        let A2 = lab[1] + dA[bin] * strength * tintable;
        let B2 = lab[2] + dB[bin] * strength * tintable;

        // 软膝而不是硬裁：硬裁会把纯红（chroma≈0.26）压到 0.18，掉饱和且出色带
        const chroma = Math.hypot(A2, B2);
        if (chroma > MAX_CHROMA) {
          const over = chroma - MAX_CHROMA;
          const target = MAX_CHROMA + over / (1 + over / 0.1);
          A2 *= target / chroma;
          B2 *= target / chroma;
        }

        const rgb = oklabToLinear(L2, A2, B2);
        out[o] = toByte(linearToSrgb(rgb[0]));
        out[o + 1] = toByte(linearToSrgb(rgb[1]));
        out[o + 2] = toByte(linearToSrgb(rgb[2]));
        out[o + 3] = 255;
        o += 4;
      }
    }
  }
  return out;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function toByte(v: number): number {
  return Math.round(clamp(v, 0, 1) * 255);
}