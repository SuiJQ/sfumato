/**
 * WebGL2 上下文与画布尺寸管理。
 *
 * 职责单一：拿到一个可用的 WebGL2 上下文，并保证 drawingBuffer 与 CSS 尺寸同步。
 * 不涉及任何渲染逻辑。
 */

export class UnsupportedGLError extends Error {
  constructor(message = '当前浏览器不支持 WebGL2') {
    super(message);
    this.name = 'UnsupportedGLError';
  }
}

export interface GLView {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  /** 与设备像素比一致，上限 2，避免 4K 屏上 3 倍超采样拖慢渲染 */
  readonly dpr: number;
  /** 把 drawingBuffer 尺寸同步到 CSS 尺寸；返回是否发生变化 */
  syncSize(): boolean;
  readonly width: number;
  readonly height: number;
}

const MAX_DPR = 2;

export function createGLView(canvas: HTMLCanvasElement): GLView {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new UnsupportedGLError();

  const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR);

  const view: GLView = {
    gl,
    canvas,
    dpr,
    width: canvas.width,
    height: canvas.height,
    syncSize(): boolean {
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (w === canvas.width && h === canvas.height) return false;
      canvas.width = w;
      canvas.height = h;
      (view as { width: number }).width = w;
      (view as { height: number }).height = h;
      return true;
    },
  };
  view.syncSize();
  return view;
}