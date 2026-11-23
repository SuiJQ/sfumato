/**
 * 全应用共享的类型定义。没有实现、没有副作用。
 */

export type ModuleId =
  | 'portrait'
  | 'sky'
  | 'foliage'
  | 'dehaze'
  | 'film'
  | 'night';

export type SliderId = 'bright' | 'warm' | 'rich' | 'clean' | 'soft' | 'style';

export type Sliders = Record<SliderId, number>; // -100..100
export type Modules = Record<ModuleId, boolean>;
export type LockedModules = ReadonlySet<ModuleId>;

export interface LumaStats {
  /** 亮度分位数，0..1 */
  p01: number;
  p50: number;
  p99: number;
  mean: number;
}

export interface ChromaStats {
  /** Oklab a/b 均值 */
  meanA: number;
  meanB: number;
  /** 饱和度（Oklab chroma 归一化）分位数 */
  satP50: number;
  satP95: number;
}

export interface RegionStats {
  sky: number;
  person: number;
  skin: number;
  green: number;
}

export interface Stats {
  luma: LumaStats;
  chroma: ChromaStats;
  noise: { sigma: number };
  regions: RegionStats;
  clip: { hi: number; lo: number };
  /** 皮肤区域平均色相角（弧度）；无人像时为 0 */
  skinHue: number;
  skinSat: number;
  /** FaceMesh 检出的人脸数 */
  face: { count: number };
  /** 分析质量：'model' 表示用了分割模型，'heuristic' 表示纯规则 */
  maskQuality: 'model' | 'heuristic' | 'none';
}

/** 送入 shader 的参数（语义命名，非 uniform 顺序） */
export interface Params {
  ev: number;
  temp: number;
  tint: number;
  s: number;

  knee: number;
  shadowLift: number;
  lcGain: number;
  mipLevel: number;

  sat: number;
  satSkin: number;
  satSky: number;
  satGreen: number;

  satRest: number;
  hueSkin: number;
  hueSky: number;
  hueGreen: number;

  lumaSkin: number;
  lumaSky: number;
  lumaGreen: number;
  sharpenAmt: number;

  sharpenLimit: number;
  grainAmt: number;
  grainSize: number;
  vignetteAmt: number;

  vignetteRadius: number;
  vignetteSoftness: number;
  styleStrength: number;
  skinNormStrength: number;

  skinTargetHue: number;
  skinTargetSat: number;
  faceLumaBoost: number;
  lumaEye: number;
}

export interface Preset {
  v: 1;
  name: string;
  auto: boolean;
  modules: Modules;
  locked: ModuleId[];
  sliders: Sliders;
  /** IndexedDB 中的 LUT id，或 null */
  lut: string | null;
}

export const SLIDER_IDS: readonly SliderId[] = [
  'bright',
  'warm',
  'rich',
  'clean',
  'soft',
  'style',
] as const;

export const MODULE_IDS: readonly ModuleId[] = [
  'portrait',
  'sky',
  'foliage',
  'dehaze',
  'film',
  'night',
] as const;

export function defaultSliders(): Sliders {
  return { bright: 0, warm: 0, rich: 0, clean: 0, soft: 0, style: 0 };
}

export function defaultModules(): Modules {
  return {
    portrait: false,
    sky: false,
    foliage: false,
    dehaze: false,
    film: false,
    night: false,
  };
}