/**
 * 导出客户端：把一次导出封装成 Promise。
 *
 * 每次导出一个 Worker，用完即弃——导出是低频操作，
 * 不值得为它维持一个长期驻留的 GL 上下文。
 */

import type { ExportRequest, ExportResult } from '../shared/protocol';

export interface ExportOptions {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  uniforms: Float32Array;
  curve: Float32Array;
  mask: Uint8Array | null;
  maskWidth: number;
  maskHeight: number;
  eyes: Uint8Array | null;
  eyeWidth: number;
  eyeHeight: number;
  lut: Uint8Array | null;
  quality?: number;
}

export function exportJpeg(opts: ExportOptions): Promise<ExportResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/export.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const done = (result: ExportResult): void => {
      worker.terminate();
      resolve(result);
    };

    worker.onmessage = (e: MessageEvent<ExportResult>) => done(e.data);
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || '导出线程出错'));
    };

    const request: ExportRequest = {
      bitmap: opts.bitmap,
      width: opts.width,
      height: opts.height,
      uniforms: opts.uniforms,
      curve: opts.curve,
      mask: opts.mask,
      maskWidth: opts.maskWidth,
      maskHeight: opts.maskHeight,
      eyes: opts.eyes,
      eyeWidth: opts.eyeWidth,
      eyeHeight: opts.eyeHeight,
      lut: opts.lut,
      quality: opts.quality ?? 0.93,
    };

    const transfer: Transferable[] = [
      opts.bitmap,
      opts.uniforms.buffer as ArrayBuffer,
      opts.curve.buffer as ArrayBuffer,
    ];
    if (opts.mask) transfer.push(opts.mask.buffer as ArrayBuffer);
    if (opts.eyes) transfer.push(opts.eyes.buffer as ArrayBuffer);
    if (opts.lut) transfer.push(opts.lut.buffer as ArrayBuffer);

    worker.postMessage(request, transfer);
  });
}