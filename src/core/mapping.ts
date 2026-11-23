/**
 * 语义层：把「统计量 + 模块开关 + 六根滑杆」翻译成 shader 参数。
 *
 * 这一层是唯一知道"强度含义"的地方。shader 只接收数值。
 */

import { clamp } from './color';
import { IDENTITY, withStrength } from './constants';
import type { LockedModules, Modules, Params, Sliders, Stats } from './types';

const WELL_DONE_SAT = 1.06;
/** 皮肤面积下限：低于此值不做人像处理（避免暖墙、木地板误触发） */
const SKIN_MIN = 0.005;

/** 万金油：全部由 stats 推导，没有魔法常数之外的硬编码 */
export function deriveWellDone(stats: Stats): Params {
  const p: Params = { ...IDENTITY };
  const { p01, p50 } = stats.luma;

  // 不再用 EV 做中灰对齐：曲线已经把 p50 映射到 0.5，
  // 两者叠加会让"亮"滑杆和曲线互相抵消（实测 +100 反而更暗）
  p.ev = 0;
  void p50;

  // 灰世界，弱化：只修正明显偏色，不动夕阳
  p.temp = clamp(-1.5 * stats.chroma.meanB, -0.2, 0.2);
  p.tint = clamp(-1.5 * stats.chroma.meanA, -0.15, 0.15);

  // 裁切越多，高光越早开始压
  p.knee = clamp(0.84 - stats.clip.hi * 6, 0.62, 0.9);

  p.shadowLift = 0.012 + 0.05 * clamp((0.15 - p01) / 0.15, 0, 1);
  p.sat = WELL_DONE_SAT;

  // 噪点重就少给细节，避免"修完更脏"
  const noise = stats.noise.sigma;
  p.lcGain = 0.24 * clamp(1 - noise / 0.06, 0.2, 1);
  p.sharpenAmt = 0.22 * clamp(1 - noise / 0.08, 0.2, 1);

  // 全局强度：噪点大的图自动收手
  p.s = noise > 0.05 ? 0.7 : 1;

  return p;
}

/** 模块开关叠加。所有增量都很小——模块是"加分项"，不是"换风格" */
export function applyModules(base: Params, modules: Modules, stats: Stats): Params {
  const p: Params = { ...base };

  if (modules.portrait && stats.regions.skin > SKIN_MIN) {
    p.satSkin = 0.96;
    p.skinNormStrength = 0.55;
    p.lumaSkin = 0.010;
    p.skinSoften = 0.35;
    p.skinTargetHue = 0.9;
    p.skinTargetSat = 0.085;
  }
  if (modules.portrait && stats.face.count > 0) {
    // 眼神光：只抬一点，多了会显得"贴图"
    p.lumaEye = 0.035;
  }

  if (modules.sky && stats.regions.sky > 0.02) {
    p.satSky = 1.10;
    p.hueSky = 0; // 不再旋转色相：云/晚霞本身带色，一转就偏
    p.lumaSky = -0.015;
  }

  if (modules.foliage && stats.regions.green > 0.02) {
    p.satGreen = 1.1;
    p.hueGreen = -0.02;
    p.lumaGreen = 0;
  }

  if (modules.dehaze) {
    p.lcGain += 0.1;
    p.knee = clamp(p.knee - 0.05, 0.55, 0.95);
    p.shadowLift = Math.max(0, p.shadowLift - 0.012);
  }

  if (modules.film) {
    p.grainAmt = 0.025;
    p.grainSize = 1.6;
    p.vignetteAmt = 0.06;
    p.sat *= 0.96;
  }

  if (modules.night) {
    p.ev += 0.15;
    p.sat = Math.max(p.sat, 1.05);
    p.lcGain += 0.04;
  }

  return p;
}

/** 六根滑杆：全部是相对量，t ∈ [-1, 1] */
export function applySliders(base: Params, sliders: Sliders): Params {
  const p: Params = { ...base };
  const t = (v: number): number => clamp(v / 100, -1, 1);

  p.ev += 0.35 * t(sliders.bright);
  p.shadowLift = Math.max(0, p.shadowLift + 0.04 * t(sliders.bright));

  p.temp = clamp(p.temp + 0.15 * t(sliders.warm), -0.6, 0.6);
  p.satSkin = Math.max(0.6, p.satSkin + 0.05 * t(sliders.warm));

  p.sat *= 1 + 0.25 * t(sliders.rich);
  p.lcGain = Math.max(0, p.lcGain + 0.15 * t(sliders.rich));
  p.hueSky -= 0.035 * t(sliders.rich);

  p.lcGain = Math.max(0, p.lcGain - 0.12 * t(sliders.clean));
  p.sat *= 1 - 0.1 * t(sliders.clean);
  p.sharpenAmt = Math.max(0, p.sharpenAmt - 0.05 * t(sliders.clean));

  p.knee = clamp(p.knee - 0.15 * t(sliders.soft), 0.45, 1);
  p.sharpenAmt = Math.max(0, p.sharpenAmt - 0.2 * t(sliders.soft));
  p.lcGain = Math.max(0, p.lcGain - 0.15 * t(sliders.soft));

  // 风格强度只有选中 LUT 时才有意义；没有 LUT 时 shader 会忽略
  p.styleStrength = clamp(p.styleStrength + t(sliders.style), 0, 1.5);

  return p;
}

/** 模块默认值规则表（§8）。film / bokeh 永不自动开启 */
export function decideModules(stats: Stats, locked: LockedModules, current: Modules): Modules {
  const out: Modules = { ...current };
  const set = (id: keyof Modules, v: boolean): void => {
    if (!locked.has(id)) out[id] = v;
  };
  // 只认人脸。曾用"人像占比 + 肤色占比"兜底，结果食物特写被 MODNet 误判出 12% 的"人"，
  // 肤色归一作用在肉和木纹上，整张图被拉灰。
  set('portrait', stats.face.count > 0);
  set('sky', stats.regions.sky > 0.08);
  set('foliage', stats.regions.green > 0.1);
  set('dehaze', stats.luma.p99 - stats.luma.p01 < 0.65);
  set('night', stats.luma.p50 < 0.35 && stats.clip.hi < 0.005);
  return out;
}

export interface Resolved {
  params: Params;
  uniform: Float32Array;
}

/**
 * 完整解析：万金油 → 模块 → 滑杆 → 全局强度。
 * 返回的 Params 已经把 s 折叠进每个量，shader 收到的就是最终值。
 */
export function resolveParams(
  stats: Stats,
  modules: Modules,
  sliders: Sliders,
  strengthOverride?: number,
  extra = 1,
): Params {
  let p = deriveWellDone(stats);
  p = applyModules(p, modules, stats);
  p = applySliders(p, sliders);
  const s = strengthOverride ?? p.s;
  const folded = withStrength(p, clamp(s * extra, 0, 1.5));
  return { ...folded, s: 1 };
}