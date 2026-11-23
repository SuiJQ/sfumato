/// <reference lib="webworker" />
/**
 * 导出 Worker：独立 GL 上下文 + 独立 OffscreenCanvas。
 *
 * 存在的意义只有一个：readPixels / 编码是同步重活，
 * 放在主线程会让拖动滑杆卡住；放在这里，阻塞的是这个 Worker。
 */

import { Renderer } from '../gl/renderer';
import type { ExportRequest, ExportResult } from '../shared/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<ExportRequest>) => {
  const req = event.data;
  let renderer: Renderer | null = null;
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('无法创建导出用的 WebGL2 上下文');

    // 超过硬件纹理上限时等比缩小（极少数 50MP 级图片）
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    let { width, height } = req;
    let bitmap = req.bitmap;
    let downscaled = false;
    if (width > maxTex || height > maxTex) {
      const scale = Math.min(maxTex / width, maxTex / height);
      width = Math.max(1, Math.floor(width * scale));
      height = Math.max(1, Math.floor(height * scale));
      const small = new OffscreenCanvas(width, height);
      const c2d = small.getContext('2d');
      if (!c2d) throw new Error('无法创建缩放上下文');
      c2d.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      bitmap = small.transferToImageBitmap();
      downscaled = true;
    }

    canvas.width = width;
    canvas.height = height;

    renderer = new Renderer(gl);
    renderer.setSource(bitmap);
    if (req.mask) renderer.setMask(req.mask, req.maskWidth, req.maskHeight);
    if (req.eyes) renderer.setEyes(req.eyes, req.eyeWidth, req.eyeHeight);
    renderer.setCurve(req.curve);
    if (req.lut) renderer.setLut(req.lut, 33);
    renderer.draw(req.uniforms, { framebuffer: null, width, height });

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: req.quality });
    const result: ExportResult = { ok: true, blob, width, height, downscaled };
    ctx.postMessage(result);
  } catch (err) {
    const result: ExportResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    ctx.postMessage(result);
  } finally {
    renderer?.dispose();
  }
};