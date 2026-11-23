/// <reference lib="webworker" />
/**
 * 守门 Worker。
 *
 * 存在的理由：守门需要"渲染一次 + 读回像素"，而 readPixels 是同步阻塞的。
 * 放在主线程意味着每次调整后都会卡一下；放在这里，阻塞的是这个 Worker。
 *
 * 同时它也是**唯一**计算基线的位置：基线与自检走完全相同的渲染路径，
 * 避免"缩略图统计 vs 渲染统计"两套数字对不上。
 */

import { Renderer } from '../gl/renderer';
import { computeStats } from '../core/stats';
import { IDENTITY, toUniforms } from '../core/constants';
import { identityCurve } from '../core/curve';
import type {
  GuardCheckResult,
  GuardMetrics,
  GuardRequest,
  GuardSourceResult,
} from '../shared/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let canvas: OffscreenCanvas | null = null;
let gl: WebGL2RenderingContext | null = null;
let renderer: Renderer | null = null;
let sourceSize: [number, number] = [1, 1];

function metricsFrom(uniforms: Float32Array, curve: Float32Array, size: number): GuardMetrics | null {
  if (!renderer || !gl || !canvas) return null;

  const ratio = sourceSize[1] / sourceSize[0];
  const w = Math.max(16, Math.round(size));
  const h = Math.max(16, Math.round(size * ratio));

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  renderer.setCurve(curve);
  renderer.draw(uniforms, { framebuffer: null, width: w, height: h });

  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

  const stats = computeStats(new ImageData(new Uint8ClampedArray(px.buffer), w, h));
  return {
    contrast: stats.luma.p99 - stats.luma.p01,
    hi: stats.clip.hi,
    lo: stats.clip.lo,
    sigma: stats.noise.sigma,
  };
}

ctx.onmessage = (event: MessageEvent<GuardRequest>) => {
  const msg = event.data;

  if (msg.t === 'source') {
    try {
      canvas = new OffscreenCanvas(msg.width, msg.height);
      gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error('守门上下文创建失败');

      renderer?.dispose();
      renderer = new Renderer(gl);
      renderer.setSource(msg.bitmap);
      renderer.setMask(msg.mask, msg.maskWidth, msg.maskHeight);
      renderer.setEyes(msg.eyes, msg.maskWidth, msg.maskHeight);
      if (msg.lut) renderer.setLut(msg.lut, 33);
      sourceSize = [msg.width, msg.height];

      const baseline = metricsFrom(toUniforms(IDENTITY), identityCurve(), 256);
      const result: GuardSourceResult = { t: 'source', ok: !!baseline, baseline: baseline ?? undefined };
      ctx.postMessage(result);
    } catch (err) {
      ctx.postMessage({
        t: 'source',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies GuardSourceResult);
    }
    return;
  }

  if (msg.t === 'assets') {
    renderer?.setMask(msg.mask, msg.maskWidth, msg.maskHeight);
    renderer?.setEyes(msg.eyes, msg.maskWidth, msg.maskHeight);
    renderer?.setLut(msg.lut, 33);
    return;
  }

  const metrics = metricsFrom(msg.uniforms, msg.curve, msg.size);
  const result: GuardCheckResult = metrics
    ? { t: 'check', id: msg.id, metrics }
    : { t: 'check', id: msg.id, error: '守门渲染失败' };
  ctx.postMessage(result);
};