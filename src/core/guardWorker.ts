/**
 * 守门 Worker 客户端。
 *
 * 约定：
 *   · setSource 返回**基线**指标（同一渲染路径、identity 参数）
 *   · check 只做"渲染一次 + 统计"，由调用方决定是否回退
 *   · 所有请求串行，过期结果由调用方的 token 丢弃
 */

import type { GuardCheckResult, GuardMetrics, GuardRequest, GuardSourceResult } from '../shared/protocol';

export interface GuardAssets {
  mask: Uint8Array | null;
  maskWidth: number;
  maskHeight: number;
  eyes: Uint8Array | null;
  lut: Uint8Array | null;
}

function emptyAssets(): GuardAssets {
  return { mask: null, maskWidth: 1, maskHeight: 1, eyes: null, lut: null };
}

export class GuardWorkerClient {
  private readonly worker: Worker;
  private seq = 1;
  private pending = new Map<number, (m: GuardMetrics | null) => void>();
  private sourceResolve: ((b: GuardMetrics | null) => void) | null = null;
  private disposed = false;

  constructor() {
    this.worker = new Worker(new URL('../workers/guard.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<GuardSourceResult | GuardCheckResult>) => {
      const msg = e.data;
      if (msg.t === 'source') {
        this.sourceResolve?.(msg.ok ? (msg.baseline ?? null) : null);
        this.sourceResolve = null;
        return;
      }
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg.metrics ?? null);
      }
    };
    this.worker.onerror = () => {
      this.sourceResolve?.(null);
      this.sourceResolve = null;
      for (const resolve of this.pending.values()) resolve(null);
      this.pending.clear();
    };
  }

  /** 建立/替换守门用的源图（1024px 副本），返回基线指标 */
  setSource(
    bitmap: ImageBitmap,
    width: number,
    height: number,
    assets: GuardAssets = emptyAssets(),
  ): Promise<GuardMetrics | null> {
    if (this.disposed) {
      bitmap.close();
      return Promise.resolve(null);
    }
    const request: GuardRequest = {
      t: 'source',
      bitmap,
      width,
      height,
      mask: assets.mask,
      maskWidth: assets.maskWidth,
      maskHeight: assets.maskHeight,
      eyes: assets.eyes,
      lut: assets.lut,
    };
    const transfer: Transferable[] = [bitmap];
    if (assets.mask) transfer.push(assets.mask.buffer as ArrayBuffer);
    if (assets.eyes) transfer.push(assets.eyes.buffer as ArrayBuffer);
    if (assets.lut) transfer.push(assets.lut.buffer as ArrayBuffer);

    return new Promise<GuardMetrics | null>((resolve) => {
      this.sourceResolve = resolve;
      this.worker.postMessage(request, transfer);
    });
  }

  /** mask / 眼睛 / LUT 变化后同步（不重新计算基线） */
  setAssets(assets: GuardAssets): void {
    if (this.disposed) return;
    const request: GuardRequest = {
      t: 'assets',
      mask: assets.mask,
      maskWidth: assets.maskWidth,
      maskHeight: assets.maskHeight,
      eyes: assets.eyes,
      lut: assets.lut,
    };
    const transfer: Transferable[] = [];
    if (assets.mask) transfer.push(assets.mask.buffer as ArrayBuffer);
    if (assets.eyes) transfer.push(assets.eyes.buffer as ArrayBuffer);
    if (assets.lut) transfer.push(assets.lut.buffer as ArrayBuffer);
    this.worker.postMessage(request, transfer);
  }

  check(uniforms: Float32Array, curve: Float32Array, size: number): Promise<GuardMetrics | null> {
    if (this.disposed) return Promise.resolve(null);
    const id = this.seq++;
    const request: GuardRequest = {
      t: 'check',
      id,
      uniforms: uniforms.slice(),
      curve: curve.slice(),
      size,
    };
    return new Promise<GuardMetrics | null>((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage(request);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
  }
}