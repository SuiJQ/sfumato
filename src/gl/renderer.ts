/**
 * 渲染器：一次 draw 完成整条管线。
 *
 * 预览（canvas）与导出（OffscreenCanvas / FBO）共用本类，
 * 因此"预览好看、导出翻车"这一整类问题在架构上不存在。
 */

import vertexSource from './shaders/pipeline.vert?raw';
import fragmentSource from './shaders/pipeline.frag?raw';
import { createProgram, deleteProgram, type Program } from './shader';
import {
  createCurveTexture,
  createLutTexture,
  createMaskTexture,
  createSourceTexture,
  updateCurveTexture,
  uploadLut,
  uploadMaskData,
  type SourceTexture,
} from './textures';

export interface RenderTarget {
  framebuffer: WebGLFramebuffer | null;
  width: number;
  height: number;
}

export const LUT_SIZE = 33;

function identity3d(size: number): Uint8Array {
  const out = new Uint8Array(size * size * size * 4);
  let o = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        out[o++] = Math.round((r / (size - 1)) * 255);
        out[o++] = Math.round((g / (size - 1)) * 255);
        out[o++] = Math.round((b / (size - 1)) * 255);
        out[o++] = 255;
      }
    }
  }
  return out;
}

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: Program;
  private readonly vao: WebGLVertexArrayObject;
  private source: SourceTexture | null = null;

  private readonly maskTex: WebGLTexture;
  private readonly eyeTex: WebGLTexture;
  private readonly curveTex: WebGLTexture;
  private readonly lutTex: WebGLTexture;
  private maskSize: [number, number] = [1, 1];
  /** 复用的离屏目标：守门每几百毫秒就要读一次像素，不能每次都新建 FBO */
  private scratch: { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } | null = null;
  private hasMask = false;
  private hasEyes = false;
  private hasLut = false;
  private lastCurve: Float32Array | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, vertexSource, fragmentSource);

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('无法创建 VAO');
    this.vao = vao;

    this.maskTex = createMaskTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );

    this.eyeTex = createMaskTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, this.eyeTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );

    this.curveTex = createCurveTexture(gl, new Float32Array(256 * 4).fill(1));

    this.lutTex = createLutTexture(gl, LUT_SIZE);
    uploadLut(gl, this.lutTex, LUT_SIZE, identity3d(LUT_SIZE));
  }

  get size(): { width: number; height: number } | null {
    return this.source ? { width: this.source.width, height: this.source.height } : null;
  }

  setSource(bitmap: ImageBitmap): void {
    this.disposeSource();
    this.source = createSourceTexture(this.gl, bitmap);
  }

  clearSource(): void {
    this.disposeSource();
  }

  setMask(source: Uint8Array | null, width = 1, height = 1): void {
    if (!source) {
      this.hasMask = false;
      return;
    }
    uploadMaskData(this.gl, this.maskTex, source, width, height);
    this.maskSize = [width, height];
    this.hasMask = true;
  }

  setEyes(source: Uint8Array | null, width = 1, height = 1): void {
    if (!source) {
      this.hasEyes = false;
      return;
    }
    uploadMaskData(this.gl, this.eyeTex, source, width, height);
    this.hasEyes = true;
  }

  setCurve(data: Float32Array): void {
    this.lastCurve = data;
    updateCurveTexture(this.gl, this.curveTex, data);
  }

  setLut(data: Uint8Array | null, size = LUT_SIZE): void {
    if (size !== LUT_SIZE) {
      // 纹理按 33³ 创建，写入别的尺寸会越界且静默失败
      console.warn(`[renderer] LUT 尺寸必须是 ${LUT_SIZE}，收到 ${size}，已忽略`);
      this.hasLut = false;
      uploadLut(this.gl, this.lutTex, LUT_SIZE, identity3d(LUT_SIZE));
      return;
    }
    this.hasLut = data !== null;
    uploadLut(this.gl, this.lutTex, LUT_SIZE, data ?? identity3d(LUT_SIZE));
  }

  draw(uniforms: Float32Array, target: RenderTarget): void {
    const gl = this.gl;
    if (!this.source) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);

    gl.useProgram(this.program.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.source.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.eyeTex);

    const u = this.program.uniforms;
    gl.uniform1i(u.get('u_tex') ?? null, 0);
    gl.uniform1i(u.get('u_mask') ?? null, 1);
    gl.uniform1i(u.get('u_curve') ?? null, 2);
    gl.uniform1i(u.get('u_lut') ?? null, 3);
    gl.uniform1i(u.get('u_mask2') ?? null, 4);
    gl.uniform4fv(u.get('u_p') ?? null, uniforms);
    gl.uniform2f(u.get('u_res') ?? null, target.width, target.height);
    gl.uniform2f(u.get('u_maskSize') ?? null, this.maskSize[0], this.maskSize[1]);
    gl.uniform1f(u.get('u_hasMask') ?? null, this.hasMask ? 1 : 0);
    gl.uniform1f(u.get('u_hasEye') ?? null, this.hasEyes ? 1 : 0);
    gl.uniform1f(u.get('u_hasLut') ?? null, this.hasLut && uniforms[6 * 4 + 2] > 1e-4 ? 1 : 0);

    // 显示采样所处的 mip：原图比目标大多少倍
    const maxTex = Math.max(this.source.width, this.source.height);
    const maxTarget = Math.max(target.width, target.height);
    gl.uniform1f(u.get('u_lodBase') ?? null, Math.max(0, Math.log2(maxTex / maxTarget)));

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * 读回当前绑定的帧缓冲。
   *
   * 约定：返回值统一为**自上而下**的 RGBA，与 ImageData 一致。
   * - 渲染目标（FBO）：GL 第 0 行是屏幕底部，需要翻转。
   * - 源纹理直接读取：上传时第 0 行就是图像顶部，不得翻转。
   */
  readPixels(width: number, height: number, flip: boolean): Uint8ClampedArray {
    const gl = this.gl;
    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    if (!flip) return new Uint8ClampedArray(raw.buffer);
    const out = new Uint8ClampedArray(width * height * 4);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      out.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    return out;
  }

  /**
   * 离屏渲染到指定尺寸并读回像素。
   * 用于测试与需要像素级比对的分析，不用于最终导出（导出直接走 canvas 编码）。
   */
  renderToBuffer(
    width: number,
    height: number,
    uniforms: Float32Array,
    curve?: Float32Array,
  ): Uint8ClampedArray {
    const gl = this.gl;
    const prevCurve = this.lastCurve;
    if (curve) this.setCurve(curve);

    if (!this.scratch || this.scratch.w !== width || this.scratch.h !== height) {
      if (this.scratch) {
        gl.deleteFramebuffer(this.scratch.fb);
        gl.deleteTexture(this.scratch.tex);
        this.scratch = null;
      }
      const tex = gl.createTexture();
      const fb = gl.createFramebuffer();
      if (!tex || !fb) throw new Error('无法创建离屏目标');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.scratch = { fb, tex, w: width, h: height };
    }

    try {
      this.draw(uniforms, { framebuffer: this.scratch.fb, width, height });
      // draw() 收尾会解绑 FBO（为了不把状态漏给下一个调用者），
      // 这里必须重新绑回离屏目标再校验/回读
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratch.fb);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`离屏目标不完整 (0x${status.toString(16)})`);
      }
      return this.readPixels(width, height, true);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // 调用方可能只想要这一张用别的曲线试算，不能把常驻曲线改掉
      if (curve && prevCurve) this.setCurve(prevCurve);
    }
  }

  /** 读回源纹理的像素（自上而下）。用于恒等性测试与参考比对。 */
  readSource(): Uint8ClampedArray {
    const gl = this.gl;
    if (!this.source) throw new Error('尚未设置源图');
    const { width, height } = this.source;
    const fb = gl.createFramebuffer();
    if (!fb) throw new Error('无法创建帧缓冲');
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.source.texture, 0);
      return this.readPixels(width, height, false);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
    }
  }

  dispose(): void {
    if (this.scratch) {
      this.gl.deleteFramebuffer(this.scratch.fb);
      this.gl.deleteTexture(this.scratch.tex);
      this.scratch = null;
    }
    this.disposeSource();
    const gl = this.gl;
    gl.deleteTexture(this.maskTex);
    gl.deleteTexture(this.eyeTex);
    gl.deleteTexture(this.curveTex);
    gl.deleteTexture(this.lutTex);
    gl.deleteVertexArray(this.vao);
    deleteProgram(gl, this.program);
  }

  private disposeSource(): void {
    if (this.source) {
      this.gl.deleteTexture(this.source.texture);
      this.source = null;
    }
  }
}