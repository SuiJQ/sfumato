/**
 * 参数常量与 uniform 打包。
 *
 * 约定：shader 里没有任何 identity 判断与 amount 逻辑，
 * 所有"强度"语义都在这里通过 `identity + (target - identity) * s` 完成。
 */

import type { Params } from './types';

/** 全部算子失效时的参数。用于恒等性测试与"关闭全部效果"。 */
export const IDENTITY: Readonly<Params> = Object.freeze({
  ev: 0,
  temp: 0,
  tint: 0,
  s: 1,

  knee: 1,
  shadowLift: 0,
  lcGain: 0,
  mipLevel: 4,

  sat: 1,
  satSkin: 1,
  satSky: 1,
  satGreen: 1,

  satRest: 1,
  hueSkin: 0,
  hueSky: 0,
  hueGreen: 0,

  lumaSkin: 0,
  lumaSky: 0,
  lumaGreen: 0,
  sharpenAmt: 0,

  sharpenLimit: 0.06,
  grainAmt: 0,
  grainSize: 1.5,
  vignetteAmt: 0,

  vignetteRadius: 0.55,
  vignetteSoftness: 0.45,
  styleStrength: 0,
  skinNormStrength: 0,

  skinTargetHue: 0.85,
  skinTargetSat: 0.09,
  skinSoften: 0,
  lumaEye: 0,
});

/** uniform 数组长度（vec4 × 8） */
export const UNIFORM_FLOATS = 32;

/**
 * 把语义参数打包成 `u_p[8]`。
 * 布局见 docs/02-算子与参数规格.md §3，改动必须两边同步。
 */
export function toUniforms(p: Params): Float32Array {
  const u = new Float32Array(UNIFORM_FLOATS);
  const set = (i: number, x: number, y: number, z: number, w: number): void => {
    u[i * 4] = x;
    u[i * 4 + 1] = y;
    u[i * 4 + 2] = z;
    u[i * 4 + 3] = w;
  };
  // .w 预留：全局强度 s 已在 resolveParams 折叠进每个量，shader 不再需要它
  set(0, p.ev, p.temp, p.tint, 0);
  set(1, p.knee, p.shadowLift, p.lcGain, p.mipLevel);
  set(2, p.sat, p.satSkin, p.satSky, p.satGreen);
  set(3, p.satRest, p.hueSkin, p.hueSky, p.hueGreen);
  set(4, p.lumaSkin, p.lumaSky, p.lumaGreen, p.sharpenAmt);
  set(5, p.sharpenLimit, p.grainAmt, p.grainSize, p.vignetteAmt);
  set(6, p.vignetteRadius, p.vignetteSoftness, p.styleStrength, p.skinNormStrength);
  set(7, p.skinTargetHue, p.skinTargetSat, p.skinSoften, p.lumaEye);
  return u;
}

/** 线性插值两组参数（用于强度混合、守门员回退） */
export function mixParams(a: Params, b: Params, t: number): Params {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof Params)[]) {
    out[k] = a[k] + (b[k] - a[k]) * t;
  }
  return out;
}

/**
 * 把参数整体缩放到 s ∈ [0,1]，0 表示恒等。
 *
 * 注意：knee 不参与插值。IDENTITY 的 knee=1 表示"不做高光柔化"，
 * 若跟着一起插值，回退强度反而会削弱 rolloff，导致高光切得更狠——
 * 对"高光被切"这个失败原因会形成自激。
 */
export function withStrength(p: Params, s: number): Params {
  const out = mixParams(IDENTITY, p, s);
  out.knee = p.knee;
  out.mipLevel = p.mipLevel;
  out.sharpenLimit = p.sharpenLimit;
  return out;
}