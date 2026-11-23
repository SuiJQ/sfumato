/**
 * Editor：把「图片 + 一组调整」变成一个可渲染的状态机。
 *
 * 职责边界：
 *   · 只负责"状态 → 像素"，UI 通过 onChange 订阅，不做双向绑定
 *   · 重活（分析、导出、守门）全部在 Worker；主线程不做 readPixels
 *   · 守门只拿 Worker 返回的指标做判断，保证与渲染路径完全一致
 */

import { emptyStats, computeStats, estimateNoise } from '../core/stats';
import {
  SLIDER_IDS,
  defaultModules,
  defaultSliders,
  type LockedModules,
  type ModuleId,
  type Modules,
  type Params,
  type SliderId,
  type Sliders,
  type Stats,
  type Preset,
} from '../core/types';
import { IDENTITY, toUniforms } from '../core/constants';
import { buildCurve, identityCurve } from '../core/curve';
import { decideModules, resolveParams } from '../core/mapping';
import { decodeFile, thumbnail, type DecodedImage } from '../core/decode';
import { createGLView, type GLView } from '../gl/context';
import { Renderer } from '../gl/renderer';
import { exportJpeg } from '../core/export';
import { Analyzer } from '../core/analyze';
import { makePreset } from '../core/presets';
import { judge } from '../core/guard';
import { GuardWorkerClient, type GuardAssets } from '../core/guardWorker';
import { detectFaces, preloadFace, type FaceOptions, type FaceShape } from '../core/face';
import type { ExportResult, FacePolygons, GuardMetrics } from '../shared/protocol';

const ANALYSIS_SIZE = 512;
const GUARD_SIZE = 256;
const GUARD_DELAY_MS = 400;
const GUARD_MAX_RETRIES = 1;
const HISTORY_LIMIT = 30;
const NOISE_CROP = 512;
const GUARD_SOURCE = 1024;

/** 局部对比的模糊半径按**原图尺寸**取 mip，保证预览与导出的物理半径一致 */
export function mipLevelFor(maxDim: number): number {
  return Math.min(8, Math.max(3, Math.round(Math.log2(Math.max(maxDim, 1) / 1000)) + 4));
}

export interface PerfSample {
  loadMs: number;
  analysisMs: number;
  exportMs: number;
}

interface Snapshot {
  sliders: Sliders;
  modules: Modules;
  locked: ModuleId[];
}

export class Editor {
  readonly view: GLView;
  readonly renderer: Renderer;

  private image: DecodedImage | null = null;
  private statsValue: Stats = emptyStats();
  private curveValue: Float32Array = identityCurve();
  private modulesValue: Modules = defaultModules();
  private lockedValue = new Set<ModuleId>();
  private slidersValue: Sliders = defaultSliders();
  private paramsValue: Params = { ...IDENTITY };
  private uniformsValue = toUniforms(IDENTITY);
  private raf = 0;
  private needsRender = false;

  /** 低分辨率区域权重（P3） */
  private maskRef: { data: Uint8Array; width: number; height: number } | null = null;
  /** 眼睛权重（FaceMesh 产出） */
  private eyeRef: { data: Uint8Array; width: number; height: number } | null = null;
  /** 最近一次送入 Worker 的人脸多边形（调试/验收用） */
  private facesValue: FacePolygons[] = [];

  private analyzer: Analyzer | null = null;
  private analysisToken = 0;
  private analysisPromise: Promise<void> = Promise.resolve();
  private faceOptions: FaceOptions;

  /** 33³ 风格 LUT（P4） */
  private lutRef: { data: Uint8Array; size: number; id: string } | null = null;

  /** 守门（Worker） */
  private guardClient: GuardWorkerClient | null = null;
  private guardBaseline: GuardMetrics | null = null;
  private guardFactor = 1;
  private guardRetries = 0;
  private guardTimer = 0;
  /** 源图切换令牌（只被换图/清空打断） */
  private guardSourceToken = 0;
  /** 单次自检令牌（只被新的自检打断） */
  private guardCheckToken = 0;
  private guardReady: Promise<void> = Promise.resolve();
  /** 守门串行化：并发跑会把彼此的结果当过期丢掉，导致 note 时有时无 */
  private guardInFlight: Promise<void> | null = null;
  private guardNoteValue = '';

  /** 撤销栈 */
  private history: Snapshot[] = [];

  private perfValue: PerfSample = { loadMs: 0, analysisMs: 0, exportMs: 0 };

  private readonly onResize = (): void => this.handleResize();

  onChange: (() => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.view = createGLView(canvas);
    this.renderer = new Renderer(this.view.gl);
    this.faceOptions = {
      wasmDir: new URL(`${import.meta.env.BASE_URL}vision/`, document.baseURI).href,
      modelUrl: new URL(
        `${import.meta.env.BASE_URL}models/face_landmarker.task`,
        document.baseURI,
      ).href,
    };
    globalThis.addEventListener('resize', this.onResize);
  }

  /** 预热 FaceMesh：首帧之后空闲时调用，避免第一次载图多等 300ms */
  preloadFaceModel(): void {
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => void })
      .requestIdleCallback;
    if (idle) idle(() => preloadFace(this.faceOptions));
    else setTimeout(() => preloadFace(this.faceOptions), 800);
  }

  // ---------- 只读状态 ----------

  get loaded(): boolean {
    return this.image !== null;
  }
  get name(): string {
    return this.image?.name ?? '';
  }
  get size(): { width: number; height: number } | null {
    return this.renderer.size;
  }
  get stats(): Stats {
    return this.statsValue;
  }
  get modules(): Modules {
    return this.modulesValue;
  }
  get sliders(): Sliders {
    return this.slidersValue;
  }
  get params(): Params {
    return this.paramsValue;
  }
  get curve(): Float32Array {
    return this.curveValue;
  }
  get uniforms(): Float32Array {
    return this.uniformsValue;
  }
  get locked(): LockedModules {
    return this.lockedValue;
  }
  get maskQuality(): 'model' | 'heuristic' | 'none' {
    return this.statsValue.maskQuality;
  }
  get analysisMs(): number {
    return this.perfValue.analysisMs;
  }
  get guardNote(): string {
    return this.guardNoteValue;
  }
  get perf(): PerfSample {
    return this.perfValue;
  }
  get lutId(): string | null {
    return this.lutRef?.id ?? null;
  }
  get lutData(): Uint8Array | null {
    return this.lutRef?.data ?? null;
  }
  get maskInfo(): { data: Uint8Array; width: number; height: number } | null {
    return this.maskRef;
  }
  get eyeInfo(): { data: Uint8Array; width: number; height: number } | null {
    return this.eyeRef;
  }
  get faceInfo(): FacePolygons[] {
    return this.facesValue;
  }
  /** 仅供验收脚本检查位图是否被正确释放 */
  get currentBitmap(): ImageBitmap | null {
    return this.image?.bitmap ?? null;
  }
  get canUndo(): boolean {
    return this.history.length > 0;
  }

  // ---------- 载入 ----------

  async load(file: File): Promise<void> {
    const started = performance.now();
    const decoded = await decodeFile(file);
    await this.setImage(decoded);
    this.perfValue = { ...this.perfValue, loadMs: Math.round(performance.now() - started) };
  }

  async setImage(decoded: DecodedImage): Promise<void> {
    // 换图必须释放上一张位图，否则连续切图会稳定涨内存
    if (this.image) this.image.bitmap.close();
    this.analysisToken++;
    this.setMask(null);
    this.setEyes(null);
    this.history = [];

    this.renderer.setSource(decoded.bitmap);
    this.image = decoded;

    const thumb = await thumbnail(decoded.bitmap, ANALYSIS_SIZE);
    const stats = computeStats(thumb);

    // 噪点必须在原始分辨率上估：缩略图的插值会把高频噪声抹平
    stats.noise = { sigma: await this.estimateNoiseNative(decoded.bitmap) };
    this.statsValue = stats;

    this.lockedValue = new Set();
    this.slidersValue = defaultSliders();
    this.modulesValue = decideModules(this.statsValue, this.lockedValue, defaultModules());

    this.guardFactor = 1;
    this.guardRetries = 0;
    this.guardNoteValue = '';
    this.guardBaseline = null;

    this.applyStatsToParams();
    this.fitCanvas();
    this.renderNow();
    this.onChange?.();

    // 守门源图与基线（后台，不阻塞首帧）
    this.guardReady = this.initGuard().catch(() => undefined);
    // 先出画面，再在后台补 mask：用户永远先看到东西
    this.analysisPromise = this.runAnalysis();
  }

  clear(): void {
    this.analysisToken++;
    this.guardSourceToken++;
    this.guardCheckToken++;
    this.setMask(null);
    this.setEyes(null);
    this.renderer.clearSource();
    this.image?.bitmap.close();
    this.image = null;
    this.statsValue = emptyStats();
    this.paramsValue = { ...IDENTITY };
    this.uniformsValue = toUniforms(IDENTITY);
    this.guardBaseline = null;
    this.history = [];
    if (this.guardTimer) window.clearTimeout(this.guardTimer);
    this.guardTimer = 0;
    this.onChange?.();
  }

  /** 批量导出用：等待当前这张图的分析（含 mask）完成 */
  async waitForAnalysis(): Promise<void> {
    try {
      await this.analysisPromise;
    } catch {
      /* 分析失败不影响导出 */
    }
  }

  dispose(): void {
    this.analysisToken++;
    this.guardSourceToken++;
    this.guardCheckToken++;
    if (this.guardTimer) window.clearTimeout(this.guardTimer);
    globalThis.removeEventListener('resize', this.onResize);
    this.analyzer?.dispose();
    this.guardClient?.dispose();
    this.guardClient = null;
    this.renderer.dispose();
    this.image?.bitmap.close();
    this.image = null;
  }

  // ---------- 调整 ----------

  /** 在用户动作开始前调用，用于撤销 */
  pushHistory(): void {
    this.history.push({
      sliders: { ...this.slidersValue },
      modules: { ...this.modulesValue },
      locked: [...this.lockedValue],
    });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  undo(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.slidersValue = { ...prev.sliders };
    this.modulesValue = { ...prev.modules };
    this.lockedValue = new Set(prev.locked);
    this.recompute();
    this.requestRender();
    this.onChange?.();
    return true;
  }

  setSlider(id: SliderId, value: number): void {
    if (!SLIDER_IDS.includes(id)) return;
    this.slidersValue = { ...this.slidersValue, [id]: value };
    this.recompute();
    this.requestRender();
    this.onChange?.();
  }

  setModule(id: ModuleId, enabled: boolean): void {
    this.modulesValue = { ...this.modulesValue, [id]: enabled };
    this.lockedValue.add(id); // 用户动过即锁定，规则表不再改写
    this.recompute();
    this.requestRender();
    this.onChange?.();
  }

  /** 解除某个模块的手动锁定，交还给规则表 */
  unlockModule(id: ModuleId): void {
    this.lockedValue.delete(id);
    this.modulesValue = decideModules(this.statsValue, this.lockedValue, this.modulesValue);
    this.recompute();
    this.requestRender();
    this.onChange?.();
  }

  reset(): void {
    this.slidersValue = defaultSliders();
    this.lockedValue = new Set();
    this.modulesValue = decideModules(this.statsValue, this.lockedValue, defaultModules());
    this.recompute();
    this.requestRender();
    this.onChange?.();
  }

  toPreset(name: string): Preset {
    return makePreset(
      name,
      this.modulesValue,
      [...this.lockedValue],
      this.slidersValue,
      this.lutRef?.id ?? null,
    );
  }

  applyPreset(preset: Preset): void {
    this.slidersValue = { ...preset.sliders };
    this.modulesValue = { ...preset.modules };
    this.lockedValue = new Set(preset.locked);
    this.recompute();
    this.requestRender();
    this.onChange?.();
  }

  setLut(data: Uint8Array | null, size = 33, id = 'inline'): void {
    this.lutRef = data ? { data, size, id } : null;
    this.renderer.setLut(data, size);
    // 选中风格即生效：把强度推到 100；移除风格才归零
    if (data && this.slidersValue.style === 0) {
      this.slidersValue = { ...this.slidersValue, style: 100 };
    }
    if (!data && this.slidersValue.style !== 0) {
      this.slidersValue = { ...this.slidersValue, style: 0 };
    }
    this.recompute();
    this.requestRender();
    this.syncGuardAssets();
    this.onChange?.();
  }

  setMask(data: Uint8Array | null, width = 1, height = 1): void {
    this.maskRef = data ? { data, width, height } : null;
    this.renderer.setMask(data, width, height);
    this.requestRender();
  }

  setEyes(data: Uint8Array | null, width = 1, height = 1): void {
    this.eyeRef = data ? { data, width, height } : null;
    this.renderer.setEyes(data, width, height);
    this.requestRender();
  }

  /** 测试与高级入口：直接给定参数与曲线（不参与守门/预设） */
  setRaw(params: Params, curve?: Float32Array): void {
    this.paramsValue = { ...params };
    this.uniformsValue = toUniforms(this.paramsValue);
    if (curve) {
      this.curveValue = curve;
      this.renderer.setCurve(curve);
    }
    this.requestRender();
  }

  // ---------- 守门 ----------

  /**
   * 立即执行一次守门检查（异步）。
   * 定时器版本用于日常输入；这里是给验收脚本与将来的"批量前自检"用的入口。
   */
  async checkGuardNow(): Promise<{ ok: boolean; note: string }> {
    // 等基线就绪：否则刚换图时调用会静默返回，看起来像"守门没生效"
    await this.guardReady;
    await this.runGuard();
    return { ok: this.guardNoteValue === '', note: this.guardNoteValue };
  }

  private async initGuard(): Promise<void> {
    const image = this.image;
    if (!image) return;
    if (!this.guardClient) this.guardClient = new GuardWorkerClient();

    const scale = Math.min(1, GUARD_SOURCE / Math.max(image.width, image.height));
    const w = Math.max(64, Math.round(image.width * scale));
    const h = Math.max(64, Math.round(image.height * scale));

    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(image.bitmap, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'high',
      });
    } catch {
      return;
    }

    const token = ++this.guardSourceToken;
    const baseline = await this.guardClient.setSource(bitmap, w, h, this.guardAssets());
    if (token !== this.guardSourceToken) return;
    this.guardBaseline = baseline;
    this.scheduleGuard();
  }

  private guardAssets(): GuardAssets {
    return {
      mask: this.maskRef ? this.maskRef.data.slice() : null,
      maskWidth: this.maskRef?.width ?? 1,
      maskHeight: this.maskRef?.height ?? 1,
      eyes: this.eyeRef ? this.eyeRef.data.slice() : null,
      lut: this.lutRef ? this.lutRef.data.slice() : null,
    };
  }

  private syncGuardAssets(): void {
    this.guardClient?.setAssets(this.guardAssets());
  }

  private scheduleGuard(): void {
    if (!this.guardBaseline) return;
    if (this.guardTimer) window.clearTimeout(this.guardTimer);
    this.guardTimer = window.setTimeout(() => {
      this.guardTimer = 0;
      void this.runGuard();
    }, GUARD_DELAY_MS);
  }

  /**
   * 守门：Worker 渲染 256px 小样并统计 → 比四项硬指标 → 越界降强度重来。
   * 上限一次回退，避免"检测-回退"互相追着跑。
   */
  private async runGuard(): Promise<void> {
    // 前一次还没跑完就等它，而不是让两个 run 互相作废
    if (this.guardInFlight) await this.guardInFlight.catch(() => undefined);
    const run = this.doGuard();
    this.guardInFlight = run;
    try {
      await run;
    } finally {
      if (this.guardInFlight === run) this.guardInFlight = null;
    }
  }

  private async doGuard(): Promise<void> {
    const baseline = this.guardBaseline;
    if (!baseline || !this.guardClient || !this.image) return;

    const sourceToken = this.guardSourceToken;
    const metrics = await this.guardClient.check(this.uniformsValue, this.curveValue, GUARD_SIZE);
    if (sourceToken !== this.guardSourceToken || !metrics) return;

    const verdict = judge(baseline, metrics);
    if (verdict.ok) {
      if (this.guardNoteValue) {
        this.guardNoteValue = '';
        this.onChange?.();
      }
      return;
    }

    if (this.guardRetries >= GUARD_MAX_RETRIES || this.guardFactor <= 0.5) {
      this.guardNoteValue = `建议手动调整（${verdict.reason}）`;
      this.onChange?.();
      return;
    }

    this.guardRetries++;
    this.guardFactor *= verdict.factor;
    this.guardNoteValue = `已自动收敛（${verdict.reason}）`;
    this.applyStatsToParams();
    this.requestRender();
    this.onChange?.();
    this.scheduleGuard();
  }

  // ---------- 分析 ----------

  private async runAnalysis(): Promise<void> {
    const image = this.image;
    if (!image) return;
    const token = ++this.analysisToken;

    if (!this.analyzer) this.analyzer = new Analyzer();

    const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
    let thumb: ImageBitmap;
    try {
      thumb = await createImageBitmap(image.bitmap, {
        resizeWidth: Math.max(32, Math.round(image.width * scale)),
        resizeHeight: Math.max(32, Math.round(image.height * scale)),
        resizeQuality: 'high',
      });
    } catch {
      return;
    }

    // FaceMesh 在主线程跑（tasks-vision 依赖 document），单次几十毫秒；
    // 拿到多边形后交给 Worker 栅格化，避免在 Worker 里加载第二套 WASM 运行时。
    let faces: FaceShape[] = [];
    try {
      faces = await detectFaces(thumb, this.faceOptions);
    } catch (err) {
      console.warn('[editor] 人脸检测失败:', err);
    }

    const polygons: FacePolygons[] = faces.map((f) => ({
      oval: f.oval.map(([x, y]) => [x, y] as [number, number]),
      eyeL: f.eyeL.map(([x, y]) => [x, y] as [number, number]),
      eyeR: f.eyeR.map(([x, y]) => [x, y] as [number, number]),
    }));

    this.facesValue = polygons;
    let mask;
    try {
      mask = await this.analyzer.analyze(thumb, polygons);
    } catch (err) {
      console.warn('[editor] 分析失败:', err);
      return;
    }

    if (token !== this.analysisToken) return;

    this.statsValue = {
      ...this.statsValue,
      regions: mask.regions,
      skinHue: mask.skinHue,
      skinSat: mask.skinSat,
      face: { count: mask.faceCount },
      maskQuality: mask.quality,
    };
    this.perfValue = { ...this.perfValue, analysisMs: mask.ms };
    this.setMask(mask.data, mask.width, mask.height);
    this.setEyes(mask.faceCount > 0 ? mask.eyeData : null, mask.width, mask.height);
    this.modulesValue = decideModules(this.statsValue, this.lockedValue, this.modulesValue);
    this.recompute();
    this.requestRender();
    this.syncGuardAssets();
    this.onChange?.();
  }

  /** 在原始分辨率的一块中心区域上估噪点 */
  private async estimateNoiseNative(bitmap: ImageBitmap): Promise<number> {
    const w = Math.max(32, Math.min(NOISE_CROP, bitmap.width));
    const h = Math.max(32, Math.min(NOISE_CROP, bitmap.height));
    const sx = Math.max(0, Math.round((bitmap.width - w) / 2));
    const sy = Math.max(0, Math.round((bitmap.height - h) / 2));

    try {
      const crop =
        w === bitmap.width && h === bitmap.height
          ? await createImageBitmap(bitmap)
          : await createImageBitmap(bitmap, sx, sy, w, h);
      const canvas = new OffscreenCanvas(w, h);
      const c2d = canvas.getContext('2d', { willReadFrequently: true });
      if (!c2d) {
        crop.close();
        return this.statsValue.noise.sigma;
      }
      c2d.drawImage(crop, 0, 0);
      crop.close();
      const data = c2d.getImageData(0, 0, w, h);
      return estimateNoise(data.data, w, h);
    } catch {
      return this.statsValue.noise.sigma;
    }
  }

  // ---------- 导出 ----------

  /** 导出：全分辨率、JPEG。位图与会话解耦，避免 transfer 破坏预览。 */
  async exportJpeg(quality = 0.93): Promise<ExportResult> {
    const image = this.image;
    if (!image) return { ok: false, error: '尚未载入图片' };

    const started = performance.now();
    const bitmap = await createImageBitmap(image.bitmap);
    const mask = this.maskRef ? this.maskRef.data.slice() : null;
    const eyes = this.eyeRef ? this.eyeRef.data.slice() : null;

    const result = await exportJpeg({
      bitmap,
      width: image.width,
      height: image.height,
      uniforms: this.uniformsValue.slice(),
      curve: this.curveValue.slice(),
      mask,
      maskWidth: this.maskRef?.width ?? 1,
      maskHeight: this.maskRef?.height ?? 1,
      eyes,
      eyeWidth: this.eyeRef?.width ?? 1,
      eyeHeight: this.eyeRef?.height ?? 1,
      lut: this.lutRef ? this.lutRef.data.slice() : null,
      quality,
    });

    this.perfValue = { ...this.perfValue, exportMs: Math.round(performance.now() - started) };
    return result;
  }

  /**
   * 当前**渲染结果**的小样。
   * 学风格必须以"已调色后的画面"为起点，否则 LUT 会把万金油的效果再算一遍。
   */
  renderedThumbnail(size = 256): ImageData | null {
    const dims = this.renderer.size;
    if (!dims) return null;
    const w = Math.max(16, Math.round(size));
    const h = Math.max(16, Math.round((size * dims.height) / dims.width));
    const px = this.renderPixels(w, h);
    return new ImageData(new Uint8ClampedArray(px), w, h);
  }

  /** 供"从参考图学习"使用的当前图小样 */
  async thumbnailData(size = 256): Promise<ImageData | null> {
    if (!this.image) return null;
    return thumbnail(this.image.bitmap, size);
  }

  // ---------- 渲染 ----------

  requestRender(): void {
    this.needsRender = true;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.needsRender) {
        this.needsRender = false;
        this.renderNow();
      }
    });
  }

  renderNow(): void {
    if (!this.image) return;
    this.view.syncSize();
    this.renderer.draw(this.uniformsValue, {
      framebuffer: null,
      width: this.view.width,
      height: this.view.height,
    });
  }

  /** 离屏渲染到指定尺寸，返回自上而下的 RGBA 像素 */
  renderPixels(
    width: number,
    height: number,
    params: Params = this.paramsValue,
    curve: Float32Array = this.curveValue,
  ): Uint8ClampedArray {
    return this.renderer.renderToBuffer(width, height, toUniforms(params), curve);
  }

  // ---------- 内部 ----------

  private applyStatsToParams(): void {
    const maxDim = this.image ? Math.max(this.image.width, this.image.height) : 1000;
    const base = resolveParams(
      this.statsValue,
      this.modulesValue,
      this.slidersValue,
      undefined,
      this.guardFactor,
    );
    this.paramsValue = { ...base, mipLevel: mipLevelFor(maxDim) };
    this.uniformsValue = toUniforms(this.paramsValue);

    // 曲线锚点依赖 ev，滑杆一动 ev 就变，必须同步重建（256 点，成本可忽略）
    const curve = buildCurve(this.statsValue, this.paramsValue.ev);
    this.curveValue = curve;
    this.renderer.setCurve(curve);
  }

  /** 用户驱动的变更：重置守门系数并安排一次自检 */
  private recompute(): void {
    this.guardFactor = 1;
    this.guardRetries = 0;
    this.applyStatsToParams();
    this.scheduleGuard();
  }

  private fitCanvas(): void {
    const size = this.renderer.size;
    const stage = this.canvas.parentElement;
    if (!size || !stage) return;
    const rect = stage.getBoundingClientRect();
    const pad = 32;
    // fit 模式：缩到装得下，但不放大（避免小图糊成马赛克）
    const scale = Math.min(
      (rect.width - pad) / size.width,
      (rect.height - pad) / size.height,
      1,
    );
    this.canvas.style.width = `${Math.max(1, Math.round(size.width * scale))}px`;
    this.canvas.style.height = `${Math.max(1, Math.round(size.height * scale))}px`;
    this.view.syncSize();
  }

  private handleResize(): void {
    if (!this.image) return;
    this.fitCanvas();
    this.requestRender();
  }

  /** 视图缩放模式：fit = 适应窗口（不放大），actual = 1:1 像素 */
  private zoom: 'fit' | 'actual' = 'fit';

  setZoom(mode: 'fit' | 'actual'): void {
    this.zoom = mode;
    if (!this.image) return;
    if (mode === 'actual') {
      const size = this.renderer.size;
      if (!size) return;
      this.canvas.style.width = `${size.width}px`;
      this.canvas.style.height = `${size.height}px`;
      this.view.syncSize();
      this.requestRender();
      return;
    }
    this.fitCanvas();
    this.requestRender();
  }

  get zoomMode(): 'fit' | 'actual' {
    return this.zoom;
  }
}