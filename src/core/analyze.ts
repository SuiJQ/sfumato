/**
 * 分析客户端：常驻 Worker + 串行队列（最新一次总是最后执行）。
 *
 * 串行是刻意的：模型推理本来就不能并行，排队比并发更省内存，
 * 也更符合"用户换图 → 只关心最后一张"的实际语义。
 */

import type {
  AnalyzeInit,
  AnalyzeMask,
  AnalyzeRequest,
  AnalyzeResult,
  FacePolygons,
} from '../shared/protocol';

export class Analyzer {
  private worker: Worker;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: { wasmBase?: string; modelUrl?: string } = {}) {
    this.worker = new Worker(new URL('../workers/analyze.worker.ts', import.meta.url), {
      type: 'module',
    });
    // 必须用绝对 URL：Worker 内的 import() 以 worker 脚本所在目录为基准，
    // 相对路径会解析到 /assets/ 下。
    const init: AnalyzeInit = {
      t: 'init',
      wasmBase:
        options.wasmBase ?? new URL(`${import.meta.env.BASE_URL}ort/`, document.baseURI).href,
      modelUrl:
        options.modelUrl ??
        new URL(`${import.meta.env.BASE_URL}models/modnet_int8.onnx`, document.baseURI).href,
    };
    this.worker.postMessage(init);
  }

  analyze(bitmap: ImageBitmap, faces: FacePolygons[] = []): Promise<AnalyzeMask> {
    const run = (): Promise<AnalyzeMask> =>
      new Promise<AnalyzeMask>((resolve, reject) => {
        if (this.disposed) {
          bitmap.close();
          reject(new Error('分析器已释放'));
          return;
        }

        const onMessage = (e: MessageEvent<AnalyzeResult>): void => {
          this.worker.removeEventListener('message', onMessage);
          if (!e.data.ok || !e.data.mask) {
            bitmap.close();
            reject(new Error(e.data.error ?? '分析失败'));
            return;
          }
          resolve(e.data.mask);
        };

        this.worker.addEventListener('message', onMessage);
        const request: AnalyzeRequest = {
          bitmap,
          width: bitmap.width,
          height: bitmap.height,
          faces,
        };
        // 注意：bitmap 在 Worker 内部会被 close()，这里不再持有
        this.worker.postMessage(request, [bitmap]);
      });

    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
  }
}