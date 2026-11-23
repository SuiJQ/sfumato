/**
 * 图像统计：为"万金油"提供依据。
 *
 * 输入是已缩放到长边 ≤ 512 的 ImageData，纯 CPU 计算，约 5–10ms。
 * 亮度统计在 **sRGB 编码域** 上进行（与曲线的工作域一致），
 * 色度统计在 Oklab 上进行。
 */

import { linearToOklab, luma, srgbToLinear } from './color';
import type { Stats } from './types';

const MAX_LUMA_BINS = 256;

export function emptyStats(): Stats {
  return {
    luma: { p01: 0.02, p50: 0.5, p99: 0.95, mean: 0.5 },
    chroma: { meanA: 0, meanB: 0, satP50: 0, satP95: 0 },
    noise: { sigma: 0 },
    regions: { sky: 0, person: 0, skin: 0, green: 0 },
    clip: { hi: 0, lo: 0 },
    skinHue: 0,
    skinSat: 0,
    face: { count: 0 },
    maskQuality: 'none',
  };
}

function percentile(hist: Uint32Array, total: number, q: number): number {
  const target = total * q;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return (i + 0.5) / hist.length;
  }
  return 1;
}

/**
 * 稳健噪点估计：4 邻域残差的中位绝对值。
 *
 * 早期版本只取水平右邻、且按 stride 跳采样，高频噪声会被直接跳过，
 * 导致 sigma 系统性偏低、守门的"噪点增加"规则形同虚设。
 * 这里改为全像素（每隔 1 个采样）+ 4 邻域，且不依赖图像尺寸。
 *
 * @param px     RGBA8
 * @param width  图像宽
 * @param height 图像高
 */
export function estimateNoise(px: Uint8ClampedArray, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  const diffs: number[] = [];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      if (px[i + 3] < 8) continue;
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      const il = i - 4;
      const ir = i + 4;
      const iu = i - width * 4;
      const id = i + width * 4;
      const avg =
        0.25 *
        ((0.2126 * px[il] + 0.7152 * px[il + 1] + 0.0722 * px[il + 2]) +
          (0.2126 * px[ir] + 0.7152 * px[ir + 1] + 0.0722 * px[ir + 2]) +
          (0.2126 * px[iu] + 0.7152 * px[iu + 1] + 0.0722 * px[iu + 2]) +
          (0.2126 * px[id] + 0.7152 * px[id + 1] + 0.0722 * px[id + 2]));
      diffs.push(Math.abs(l - avg) / 255);
    }
  }

  if (diffs.length === 0) return 0;
  diffs.sort((a, b) => a - b);
  const mad = diffs[diffs.length >> 1];
  // 白噪声下 4 邻域残差的标准差 ≈ σ·1.118，故 σ = 1.4826·MAD/1.118
  return (1.4826 * mad) / 1.118;
}

/**
 * @param data   RGBA8 像素
 * @param width  实际宽度
 * @param height 实际高度
 */
export function computeStats(data: ImageData, width = data.width, height = data.height): Stats {
  const px = data.data;
  const n = width * height;
  const hist = new Uint32Array(MAX_LUMA_BINS);

  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  let hi = 0;
  let lo = 0;
  let green = 0;
  let valid = 0;

  const satHist = new Uint32Array(MAX_LUMA_BINS);
  const sats = new Float32Array(n);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // 透明像素在 shader 里会被合成到白底，统计里必须跳过，
    // 否则会当成纯黑，把曝光和 knee 全带偏
    if (px[p + 3] < 8) continue;
    const r8 = px[p];
    const g8 = px[p + 1];
    const b8 = px[p + 2];
    valid++;

    // 编码域亮度（与显示一致）
    const le = luma(r8 / 255, g8 / 255, b8 / 255);
    sumL += le;
    hist[Math.min(MAX_LUMA_BINS - 1, (le * MAX_LUMA_BINS) | 0)]++;

    // 两端统一口径：只有"三通道都顶到"才算裁切
    if (r8 >= 250 && g8 >= 250 && b8 >= 250) hi++;
    if (r8 <= 5 && g8 <= 5 && b8 <= 5) lo++;

    const rl = srgbToLinear(r8 / 255);
    const gl = srgbToLinear(g8 / 255);
    const bl = srgbToLinear(b8 / 255);
    const [L, A, B] = linearToOklab(rl, gl, bl);
    sumA += A;
    sumB += B;
    void L;

    const chroma = Math.hypot(A, B);
    sats[i] = chroma;
    satHist[Math.min(MAX_LUMA_BINS - 1, (Math.min(chroma, 1) * MAX_LUMA_BINS) | 0)]++;

    if (g8 > r8 * 1.12 && g8 > b8 * 1.12 && g8 > 40) green++;
  }

  const sigma = estimateNoise(px, width, height);
  const total = Math.max(1, valid);

  return {
    luma: {
      p01: percentile(hist, total, 0.01),
      p50: percentile(hist, total, 0.5),
      p99: percentile(hist, total, 0.99),
      mean: sumL / total,
    },
    chroma: {
      meanA: sumA / total,
      meanB: sumB / total,
      satP50: percentile(satHist, total, 0.5),
      satP95: percentile(satHist, total, 0.95),
    },
    noise: { sigma },
    regions: { sky: 0, person: 0, skin: 0, green: green / total },
    clip: { hi: hi / total, lo: lo / total },
    skinHue: 0,
    skinSat: 0,
    face: { count: 0 },
    maskQuality: 'none',
  };
}