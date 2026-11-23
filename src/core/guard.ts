/**
 * 守门员：出图后自检，越界就回退强度。
 *
 * 这不是"更聪明的模型"，是一条廉价的保险：
 * 只要处理后的图在四个硬指标上不比原图差，就不会出现"修完更脏"的翻车。
 */

import { computeStats } from './stats';
import type { Stats } from './types';
import type { GuardMetrics } from '../shared/protocol';

export interface GuardVerdict {
  ok: boolean;
  /** 1 表示无需回退；<1 表示应当降低强度 */
  factor: number;
  reason: string;
}

export function metricsOf(stats: Stats): GuardMetrics {
  return {
    contrast: stats.luma.p99 - stats.luma.p01,
    hi: stats.clip.hi,
    lo: stats.clip.lo,
    sigma: stats.noise.sigma,
  };
}

export function metricsOfImage(data: ImageData): GuardMetrics {
  return metricsOf(computeStats(data));
}

/**
 * 四条规则，任一越界即判定需要收手。
 *
 * 注意"对比度下降"这一条的门槛必须放得很宽：
 * 高光柔化 + 曲线压缩本来就会让 p99-p01 变小（实测正常出图约 −11%），
 * 用 15% 去卡会把好图判成坏图——守门员误伤比漏判更糟。
 */
export function judge(baseline: GuardMetrics, out: GuardMetrics): GuardVerdict {
  const absFloor = Math.min(0.12, baseline.contrast * 0.3);
  if (out.contrast < baseline.contrast * 0.72 && baseline.contrast - out.contrast > absFloor) {
    return { ok: false, factor: 0.7, reason: '对比度塌陷' };
  }
  if (out.hi > baseline.hi + 0.003) {
    return { ok: false, factor: 0.7, reason: '高光被切' };
  }
  if (out.lo > baseline.lo + 0.005) {
    return { ok: false, factor: 0.7, reason: '暗部死黑' };
  }
  if (out.sigma > baseline.sigma * 1.2 + 0.002) {
    return { ok: false, factor: 0.7, reason: '噪点增加' };
  }
  return { ok: true, factor: 1, reason: '' };
}