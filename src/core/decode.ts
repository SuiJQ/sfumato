/**
 * 解码层：只接受 JPEG / PNG。
 *
 * 校验顺序：扩展名 → 魔数 → 解码 → 像素数上限。
 * createImageBitmap 由浏览器在线程池中完成，主线程不阻塞。
 */

export interface DecodedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  name: string;
}

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

const MAX_PIXELS = 50_000_000;

type Sniffed = 'jpeg' | 'png' | null;

async function sniff(file: File): Promise<Sniffed> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) {
    return 'png';
  }
  return null;
}

/**
 * 从文件头读尺寸，避免"先解码 100MP 再拒绝"——那一下可能吃掉 400MB。
 * 读不到就返回 null（交给解码后的检查兜底）。
 */
async function readHeaderSize(file: File, kind: 'jpeg' | 'png'): Promise<{ w: number; h: number } | null> {
  const head = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer());

  if (kind === 'png' && head.length >= 24) {
    const view = new DataView(head.buffer);
    return { w: view.getUint32(16), h: view.getUint32(20) };
  }

  if (kind === 'jpeg') {
    let i = 2;
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = head[i + 1];
      // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (head[i + 5] << 8) | head[i + 6];
        const w = (head[i + 7] << 8) | head[i + 8];
        return w > 0 && h > 0 ? { w, h } : null;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (head[i + 2] << 8) | head[i + 3];
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return null;
}

export async function decodeFile(file: File): Promise<DecodedImage> {
  const kind = await sniff(file);
  if (!kind) {
    throw new DecodeError('只支持 JPEG / PNG。这个文件的格式无法识别。');
  }

  const header = await readHeaderSize(file, kind);
  if (header && header.w * header.h > MAX_PIXELS) {
    throw new DecodeError(
      `图片太大（${((header.w * header.h) / 1e6).toFixed(1)} MP，${header.w}×${header.h}）。上限是 50 MP。`,
    );
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'default',
    });
  } catch {
    throw new DecodeError('解码失败。可能是 CMYK JPEG、16bit PNG 或文件损坏。');
  }

  const pixels = bitmap.width * bitmap.height;
  if (pixels > MAX_PIXELS) {
    bitmap.close();
    throw new DecodeError(
      `图片太大（${(pixels / 1e6).toFixed(1)} MP）。上限是 50 MP。`,
    );
  }

  return { bitmap, width: bitmap.width, height: bitmap.height, name: file.name };
}

/** 生成分析用缩略图：长边 ≤ size，保持比例 */
export async function thumbnail(bitmap: ImageBitmap, size = 512): Promise<ImageData> {
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!ctx) throw new DecodeError('无法创建 2D 上下文');
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}