/**
 * 色调曲线 LUT（256×1 RGBA8）。
 *
 * 前三个通道预留给 P3 的通道曲线（当前为恒等），
 * 第四通道（A）是唯一的亮度主曲线。
 *
 * 曲线工作域是 **sRGB 编码亮度**，因此采样密度在暗部更充分。
 */

import { clamp, linearToSrgb, srgbToLinear } from './color';
import type { Stats } from './types';

const SIZE = 256;
/** 低对比图的最大扩张倍数：超过这个值，雾天风景会好看，室内人像会发硬 */
const MAX_EXPANSION = 1.8;

/** 单调三次插值（Fritsch–Carlson），保证曲线不产生反转与过冲 */
function monotoneSampler(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const d: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);

  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else m[i] = (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }

  return (x: number): number => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  };
}

/** 恒等曲线：A 通道为线性斜线（半浮点存储，避免 8bit 量化在暗部放大） */
export function identityCurve(): Float32Array {
  const out = new Float32Array(SIZE * 4);
  for (let i = 0; i < SIZE; i++) {
    const v = i / (SIZE - 1);
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = v;
  }
  return out;
}

/**
 * 自适应曲线：把图像的 p01/p50/p99 拉到固定目标位。
 *
 * 锚点必须 clamp —— 这是"万金油不翻车"的核心：极端直方图不会被拉爆。
 */
/**
 * @param ev   曝光补偿（用于把锚点换算到"加完曝光"的坐标系）
 * @param lift 中灰拉升强度：1 = 完全拉到 0.5；夜景用 0.45，避免把夜空提成灰
 */
export function buildCurve(stats: Stats, ev = 0, lift = 1): Float32Array {
  // 曲线在 EV 之后才作用，所以锚点也必须换算到"加完曝光"的坐标系里，
  // 否则中灰会被曝光和曲线各对齐一次（p50=0.25 时会被推到 ≈0.55）。
  const gain = Math.pow(2, ev);
  const warp = (x: number): number =>
    ev === 0 ? x : linearToSrgb(clamp(srgbToLinear(clamp(x, 0, 1)) * gain, 0, 1));

  const x1 = clamp(warp(clamp(stats.luma.p01, 0.02, 0.2)), 0.01, 0.35);
  const x2 = clamp(warp(clamp(stats.luma.p50, 0.22, 0.78)), x1 + 0.02, 0.9);
  const x3 = clamp(warp(clamp(stats.luma.p99, 0.72, 0.995)), x2 + 0.02, 0.999);

  const xs = [0, x1, Math.max(x2, x1 + 0.02), Math.max(x3, x2 + 0.02), 1];
  const mid = clamp(x2 + (0.5 - x2) * clamp(lift, 0, 1), 0.05, 0.9);
  const ys = [0, 0.02, mid, 0.95, 1];

  // 保证严格单调
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] <= xs[i - 1]) xs[i] = xs[i - 1] + 0.005;
  }

  // 限制扩张：实测雾天图默认会被拉到 2.3 倍，人像场景偏硬
  const rawExpansion = (ys[3] - ys[1]) / Math.max(1e-4, xs[3] - xs[1]);
  const damp = rawExpansion > MAX_EXPANSION ? MAX_EXPANSION / rawExpansion : 1;
  const ysDamped = ys.map((y, i) => xs[i] + (y - xs[i]) * damp);
  for (let i = 1; i < ysDamped.length; i++) {
    if (ysDamped[i] < ysDamped[i - 1]) ysDamped[i] = ysDamped[i - 1];
  }

  const f = monotoneSampler(xs, ysDamped);
  const out = new Float32Array(SIZE * 4);
  for (let i = 0; i < SIZE; i++) {
    const x = i / (SIZE - 1);
    const v = clamp(f(x), 0, 1);
    out[i * 4] = x; // R：恒等（预留通道曲线）
    out[i * 4 + 1] = x;
    out[i * 4 + 2] = x;
    out[i * 4 + 3] = v;
  }
  return out;
}