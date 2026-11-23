/**
 * .cube 解析与序列化。
 *
 * 内部统一使用 33³ RGBA8（sRGB 编码域）。任何输入尺寸都会先做三线性重采样，
 * 这样 GPU 侧只认一种尺寸，减少分支。
 */

export const LUT_SIZE = 33;

export interface CubeData {
  size: number;
  /** 原始顺序：red 变化最快，值域 0..1（sRGB 编码） */
  values: Float32Array;
}

export class CubeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CubeParseError';
  }
}

export function parseCube(text: string): CubeData {
  const lines = text.split(/\r?\n/);
  let size = 0;
  const values: number[] = [];
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const upper = line.toUpperCase();

    if (upper.startsWith('TITLE')) continue;
    if (upper.startsWith('LUT_3D_SIZE')) {
      size = Number(line.split(/\s+/)[1]);
      continue;
    }
    if (upper.startsWith('LUT_1D_SIZE')) {
      throw new CubeParseError('不支持 1D LUT，请使用 3D LUT。');
    }
    if (upper.startsWith('DOMAIN_MIN')) {
      const v = line.split(/\s+/).slice(1).map(Number);
      if (v.length >= 3) domainMin = [v[0], v[1], v[2]];
      continue;
    }
    if (upper.startsWith('DOMAIN_MAX')) {
      const v = line.split(/\s+/).slice(1).map(Number);
      if (v.length >= 3) domainMax = [v[0], v[1], v[2]];
      continue;
    }

    if (/^[-+0-9.eE\s]+$/.test(line)) {
      const parts = line.split(/\s+/).map(Number);
      if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
        values.push(parts[0], parts[1], parts[2]);
      }
    }
  }

  if (size < 2 || size > 128) throw new CubeParseError(`LUT_3D_SIZE 非法：${size}`);
  const expected = size * size * size * 3;
  if (values.length !== expected) {
    throw new CubeParseError(`数据行数不符：期望 ${expected / 3} 行，实际 ${values.length / 3} 行`);
  }
  // 值域不是 [0,1] 的 LUT（log/Cineon 等）必须先归一化，否则整图偏色
  for (let i = 0; i < values.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const span = domainMax[c] - domainMin[c];
      values[i + c] = Math.abs(span) < 1e-6 ? 0 : (values[i + c] - domainMin[c]) / span;
    }
  }

  return { size, values: new Float32Array(values) };
}

/** 三线性重采样到目标尺寸，并编码为 RGBA8 */
export function resampleCube(cube: CubeData, target = LUT_SIZE): Uint8Array {
  if (cube.size === target) {
    return encode(cube.values);
  }
  const out = new Float32Array(target * target * target * 3);
  const scale = (cube.size - 1) / (target - 1);
  let o = 0;
  for (let b = 0; b < target; b++) {
    for (let g = 0; g < target; g++) {
      for (let r = 0; r < target; r++) {
        const sr = r * scale;
        const sg = g * scale;
        const sb = b * scale;
        const r0 = Math.floor(sr);
        const g0 = Math.floor(sg);
        const b0 = Math.floor(sb);
        const r1 = Math.min(cube.size - 1, r0 + 1);
        const g1 = Math.min(cube.size - 1, g0 + 1);
        const b1 = Math.min(cube.size - 1, b0 + 1);
        const fr = sr - r0;
        const fg = sg - g0;
        const fb = sb - b0;
        for (let c = 0; c < 3; c++) {
          const v000 = cube.values[idx(cube.size, r0, g0, b0) + c];
          const v100 = cube.values[idx(cube.size, r1, g0, b0) + c];
          const v010 = cube.values[idx(cube.size, r0, g1, b0) + c];
          const v110 = cube.values[idx(cube.size, r1, g1, b0) + c];
          const v001 = cube.values[idx(cube.size, r0, g0, b1) + c];
          const v101 = cube.values[idx(cube.size, r1, g0, b1) + c];
          const v011 = cube.values[idx(cube.size, r0, g1, b1) + c];
          const v111 = cube.values[idx(cube.size, r1, g1, b1) + c];
          const v00 = v000 + (v100 - v000) * fr;
          const v10 = v010 + (v110 - v010) * fr;
          const v01 = v001 + (v101 - v001) * fr;
          const v11 = v011 + (v111 - v011) * fr;
          const v0 = v00 + (v10 - v00) * fg;
          const v1 = v01 + (v11 - v01) * fg;
          out[o + c] = v0 + (v1 - v0) * fb;
        }
        o += 3;
      }
    }
  }
  return encode(out);
}

function idx(size: number, r: number, g: number, b: number): number {
  return ((b * size + g) * size + r) * 3;
}

function encode(values: Float32Array): Uint8Array {
  const n = values.length / 3;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = clampByte(values[i * 3]);
    out[i * 4 + 1] = clampByte(values[i * 3 + 1]);
    out[i * 4 + 2] = clampByte(values[i * 3 + 2]);
    out[i * 4 + 3] = 255;
  }
  return out;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

export function serializeCube(data: Uint8Array, size = LUT_SIZE, title = 'grain'): string {
  const lines: string[] = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`];
  const max = size - 1;
  for (let b = 0; b <= max; b++) {
    for (let g = 0; g <= max; g++) {
      for (let r = 0; r <= max; r++) {
        const i = ((b * size + g) * size + r) * 4;
        lines.push(
          `${(data[i] / 255).toFixed(6)} ${(data[i + 1] / 255).toFixed(6)} ${(data[i + 2] / 255).toFixed(6)}`,
        );
      }
    }
  }
  return lines.join('\n');
}