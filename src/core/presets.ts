/**
 * 预设的序列化与校验。
 *
 * 预设只存"意图"（模块开关 + 六滑杆 + LUT 引用），不存参数快照，
 * 因此万金油迭代后旧预设依然成立。
 */

import {
  MODULE_IDS,
  SLIDER_IDS,
  defaultModules,
  defaultSliders,
  type ModuleId,
  type Modules,
  type Preset,
  type Sliders,
} from './types';

const clampSlider = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.max(-100, Math.min(100, Math.round(n)));
};

export function makePreset(
  name: string,
  modules: Modules,
  locked: readonly ModuleId[],
  sliders: Sliders,
  lut: string | null,
): Preset {
  return {
    v: 1,
    name,
    auto: true,
    modules: { ...modules },
    locked: [...locked],
    sliders: { ...sliders },
    lut,
  };
}

/** 宽松解析：任何不认识/越界的字段都退回默认值，绝不因预设损坏而崩溃 */
export function parsePreset(raw: unknown): Preset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1) return null;

  const modules = defaultModules();
  const modulesRaw = obj.modules;
  if (modulesRaw && typeof modulesRaw === 'object') {
    for (const id of MODULE_IDS) {
      const value = (modulesRaw as Record<string, unknown>)[id];
      if (typeof value === 'boolean') modules[id] = value;
    }
  }

  const sliders = defaultSliders();
  const slidersRaw = obj.sliders;
  if (slidersRaw && typeof slidersRaw === 'object') {
    for (const id of SLIDER_IDS) {
      sliders[id] = clampSlider((slidersRaw as Record<string, unknown>)[id]);
    }
  }

  const locked: ModuleId[] = [];
  if (Array.isArray(obj.locked)) {
    for (const id of obj.locked) {
      if (typeof id === 'string' && (MODULE_IDS as readonly string[]).includes(id)) {
        locked.push(id as ModuleId);
      }
    }
  }

  return {
    v: 1,
    name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 40) : '未命名',
    auto: obj.auto !== false,
    modules,
    locked,
    sliders,
    lut: typeof obj.lut === 'string' ? obj.lut : null,
  };
}

export function serializePreset(preset: Preset): string {
  return JSON.stringify(preset, null, 2);
}