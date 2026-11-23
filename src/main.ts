import './styles.css';
import { Editor } from './app/Editor';
import { mountModules, syncModules } from './ui/modules';
import { mountSliders } from './ui/sliders';
import { renderChips } from './ui/chips';
import { UnsupportedGLError } from './gl/context';
import { IDENTITY } from './core/constants';
import { identityCurve } from './core/curve';
import { parsePreset, serializePreset } from './core/presets';
import {
  deleteLut,
  deletePreset,
  getLut,
  listPresets,
  listLuts,
  saveLut,
  savePreset,
  type StoredLut,
  type StoredPreset,
} from './core/storage';
import type { ModuleId, Preset } from './core/types';
import { parseCube, resampleCube, serializeCube, LUT_SIZE } from './core/lut/cube';
import { buildLutFromReference } from './core/lut/transfer';
import { thumbnail } from './core/decode';

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`缺少元素 ${selector}`);
  return el;
}

const canvas = must<HTMLCanvasElement>('#view');
const stage = must<HTMLElement>('#stage');
const empty = must<HTMLElement>('#empty');
const toastEl = must<HTMLElement>('#toast');
const noticeEl = must<HTMLElement>('#notice');
const noticeText = must<HTMLElement>('#notice-text');
const noticeClose = must<HTMLButtonElement>('#notice-close');
const filename = must<HTMLElement>('#filename');
const fileInput = must<HTMLInputElement>('#file-input');
const btnOpen = must<HTMLButtonElement>('#btn-open');
const btnReset = must<HTMLButtonElement>('#btn-reset');
const btnUndo = must<HTMLButtonElement>('#btn-undo');
const btnExport = must<HTMLButtonElement>('#btn-export');
const btnZoom = must<HTMLButtonElement>('#btn-zoom');
const presetList = must<HTMLElement>('#presets');
const lutList = must<HTMLElement>('#luts');
const sliderHost = must<HTMLElement>('#sliders');
const moduleHost = must<HTMLElement>('#modules');

function fatal(message: string): never {
  stage.innerHTML = `<div class="empty"><p class="empty-title">无法启动</p><p class="empty-sub">${message}</p></div>`;
  // 启动失败时把可交互控件全部禁用，避免"点了没反应"
  for (const el of document.querySelectorAll('button, input')) {
    (el as HTMLButtonElement | HTMLInputElement).disabled = true;
  }
  throw new Error(message);
}

let editor: Editor;
try {
  editor = new Editor(canvas);
} catch (err) {
  if (err instanceof UnsupportedGLError) fatal('此工具需要 WebGL2。请使用 Chrome / Edge / Safari 16+。');
  throw err;
}

// ---------- 提示：toast（瞬时）与 notice（常驻）分开 ----------

let toastTimer = 0;
let toastSeq = 0;
function toast(text: string, ms = 1800): void {
  toastSeq++;
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.add('hidden');
    toastTimer = 0;
  }, ms);
}

let noticeSource: 'guard' | 'error' | null = null;
let noticeTimer = 0;

function showNotice(text: string, source: 'guard' | 'error', autoHide = 0): void {
  noticeText.textContent = text;
  noticeEl.classList.remove('hidden');
  noticeEl.dataset.level = source;
  noticeSource = source;
  if (noticeTimer) window.clearTimeout(noticeTimer);
  noticeTimer = autoHide ? window.setTimeout(() => hideNotice(), autoHide) : 0;
}

function hideNotice(source?: 'guard' | 'error'): void {
  if (source && noticeSource !== source) return;
  noticeEl.classList.add('hidden');
  noticeSource = null;
  if (noticeTimer) window.clearTimeout(noticeTimer);
  noticeTimer = 0;
}

noticeClose.addEventListener('click', () => hideNotice());

// ---------- 基础 UI ----------

const sliderHandles = mountSliders(sliderHost, (id, value) => {
  editor.setSlider(id, value);
});

// 一次拖动 = 一个撤销步：按下时快照，之后连续的 input 合并
sliderHost.addEventListener('pointerdown', () => editor.pushHistory());
sliderHost.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') editor.pushHistory();
});

const moduleHandles = mountModules(moduleHost, (id, enabled) => {
  editor.pushHistory();
  editor.setModule(id, enabled);
});

moduleHost.addEventListener('dblclick', (e) => {
  const row = (e.target as HTMLElement).closest('.module');
  const id = row?.getAttribute('data-module') as ModuleId | null;
  if (!id) return;
  editor.pushHistory();
  editor.unlockModule(id);
  toast('已交还自动判断');
});

function hintFor(id: ModuleId): string {
  const st = editor.stats;
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  switch (id) {
    case 'portrait':
      return st.face.count > 0 ? `人脸 ${st.face.count}` : st.regions.skin > 0.004 ? `皮肤 ${pct(st.regions.skin)}` : '未检测到';
    case 'sky':
      return st.regions.sky > 0 ? `天空 ${pct(st.regions.sky)}` : '未检测到';
    case 'foliage':
      return st.regions.green > 0 ? `绿色 ${pct(st.regions.green)}` : '未检测到';
    case 'dehaze':
      return `对比度 ${Math.round((st.luma.p99 - st.luma.p01) * 100)}`;
    case 'night':
      return `亮度 ${Math.round(st.luma.p50 * 100)}`;
    default:
      return '手动';
  }
}

function availability(id: ModuleId): boolean {
  const st = editor.stats;
  switch (id) {
    case 'portrait':
      return st.face.count > 0 || st.regions.skin > 0.005 || st.regions.person > 0.02;
    case 'sky':
      return st.regions.sky > 0.02;
    case 'foliage':
      return st.regions.green > 0.02;
    default:
      return true;
  }
}

function refresh(): void {
  filename.textContent = editor.loaded ? editor.name : '';
  empty.classList.toggle('hidden', editor.loaded);
  btnExport.disabled = !editor.loaded || busy;
  btnReset.disabled = !editor.loaded;
  btnUndo.disabled = !editor.canUndo;
  btnZoom.disabled = !editor.loaded;
  btnZoom.textContent = editor.zoomMode === 'fit' ? '适应' : '1:1';

  syncModules(moduleHandles, editor.modules);
  for (const id of Object.keys(moduleHandles) as ModuleId[]) {
    moduleHandles[id].setAvailable(availability(id));
    moduleHandles[id].setHint(hintFor(id));
    moduleHandles[id].setLocked(editor.locked.has(id));
  }

  // 没有风格时，风格滑杆禁用（否则拖了也没反应）
  sliderHandles.style.setDisabled(!editor.lutData);

  for (const id of Object.keys(sliderHandles) as (keyof typeof sliderHandles)[]) {
    sliderHandles[id].set(editor.sliders[id]);
  }

  // 守门提示与错误提示各占各的生命周期，互不覆盖
  if (editor.guardNote) showNotice(editor.guardNote, 'guard');
  else if (noticeSource === 'guard') hideNotice('guard');
}

editor.onChange = refresh;

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- 载入（互斥 + 忙碌态） ----------

let busy = false;
let loadToken = 0;

let busyToastSeq = -1;
function setBusy(on: boolean, label = '处理中…'): void {
  busy = on;
  stage.setAttribute('aria-busy', on ? 'true' : 'false');
  btnOpen.disabled = on;
  btnExport.disabled = on || !editor.loaded;
  if (on) {
    toast(label, 60000);
    busyToastSeq = toastSeq;
  } else if (toastSeq === busyToastSeq) {
    // 只清掉"进度"这一条；期间若有成功/失败提示，保留它
    toastEl.classList.add('hidden');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = 0;
  }
}

async function loadFile(file: File): Promise<void> {
  if (busy) {
    toast('正在处理，请稍候');
    return;
  }
  const token = ++loadToken;
  setBusy(true, '处理中…');
  try {
    await editor.load(file);
    if (token !== loadToken) return;
    hideNotice('error');
  } catch (err) {
    showNotice(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    if (token === loadToken) setBusy(false);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface WritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
}
interface DirHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}

let batchCancel = false;

/**
 * 批量：串行处理，一次只持有一张图。
 * 能用 File System Access API 就直接写入用户选的目录，否则退化为逐个下载。
 */
async function runBatch(files: File[]): Promise<void> {
  if (busy) {
    toast('正在处理，请稍候');
    return;
  }

  let dir: DirHandle | null = null;
  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<DirHandle> })
    .showDirectoryPicker;
  if (picker) {
    try {
      dir = await picker();
    } catch {
      dir = null; // 用户取消 → 回退到逐个下载
    }
  }

  let overwrite = true;
  if (dir) {
    overwrite = window.confirm('目录中若有同名文件，是否覆盖？\n（选"取消"则不写入，改为逐个下载）');
  }
  if (!overwrite) dir = null;

  batchCancel = false;
  setBusy(true, `批量 0/${files.length}`);
  const failed: string[] = [];

  try {
    for (let i = 0; i < files.length; i++) {
      if (batchCancel) break;
      const file = files[i];
      toast(`批量 ${i + 1}/${files.length} · ${file.name}`, 60000);
      try {
        await editor.load(file);
        await editor.waitForAnalysis();
        const result = await editor.exportJpeg();
        if (!result.ok || !result.blob) throw new Error(result.error ?? '导出失败');
        const name = `${file.name.replace(/\.[^.]+$/, '')}_grain.jpg`;
        if (dir) {
          const handle = await dir.getFileHandle(name, { create: true });
          const w = await handle.createWritable();
          await w.write(result.blob);
          await w.close();
        } else {
          download(result.blob, name);
          await sleep(700); // 多个连续下载需要间隔，否则浏览器会吞掉
        }
      } catch (err) {
        console.warn('[batch] 失败', file.name, err);
        failed.push(file.name);
      }
    }
  } finally {
    setBusy(false);
  }

  if (batchCancel) {
    showNotice(`批量已取消，已处理 ${files.length - failed.length} 张`, 'error', 6000);
  } else if (failed.length) {
    showNotice(`批量结束：成功 ${files.length - failed.length} 张，失败 ${failed.length} 张（${failed.join('、')}）`, 'error');
  } else {
    toast(`批量完成 ${files.length} 张`);
  }
}

// ---------- 输入 ----------

btnOpen.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = [...(fileInput.files ?? [])];
  fileInput.value = '';
  if (files.length > 1) void runBatch(files);
  else if (files[0]) void loadFile(files[0]);
});

stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.classList.add('dragover');
});
stage.addEventListener('dragleave', (e) => {
  // 指针进入子元素时也会触发 dragleave，用 relatedTarget 排除
  const to = e.relatedTarget as Node | null;
  if (to && stage.contains(to)) return;
  stage.classList.remove('dragover');
});
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragover');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length > 1) void runBatch(files);
  else if (files[0]) void loadFile(files[0]);
});

window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (file) void loadFile(file);
});

btnReset.addEventListener('click', () => {
  editor.pushHistory();
  editor.reset();
  toast('已重置');
});

btnUndo.addEventListener('click', () => {
  if (editor.undo()) toast('已撤销');
});

btnZoom.addEventListener('click', () => {
  editor.setZoom(editor.zoomMode === 'fit' ? 'actual' : 'fit');
  refresh();
});

// ---------- 预设 ----------

let presetsCache: StoredPreset[] = [];
let activePresetId: string | null = null;

async function refreshPresets(): Promise<void> {
  presetsCache = await listPresets();
  renderChips(
    presetList,
    presetsCache.map((p) => ({ id: p.id, label: p.name })),
    {
      activeId: activePresetId,
      emptyHint: '还没有预设 · 调好后点"存为预设"',
      onSelect: (id) => void applyPresetById(id),
      onDelete: (id) => {
        if (!window.confirm('删除这个预设？')) return;
        void deletePreset(id).then(() => {
          if (activePresetId === id) activePresetId = null;
          return refreshPresets();
        });
      },
    },
  );
}

async function applyPresetById(id: string): Promise<void> {
  const record = presetsCache.find((p) => p.id === id);
  if (!record) return;

  // IndexedDB 里的记录可能来自旧版本或被外部改坏：必须重新校验，
  // 否则 NaN 会一路传到 uniform，整屏变黑
  const preset = parsePreset(record.preset);
  if (!preset) {
    showNotice('这个预设已损坏，已跳过。', 'error', 6000);
    return;
  }

  editor.pushHistory();

  if (preset.lut) {
    const lut = await getLut(preset.lut);
    if (lut) {
      editor.setLut(lut.data, lut.size, lut.id);
    } else {
      // 预设引用的风格已被删除：必须清空，否则会沿用上一张的 LUT
      editor.setLut(null);
      showNotice('预设引用的风格已不存在，已清除风格', 'error', 6000);
    }
  } else {
    editor.setLut(null);
  }

  editor.applyPreset(preset);
  activePresetId = id;
  await refreshPresets();
}

must<HTMLButtonElement>('#btn-preset-save').addEventListener('click', () => {
  const name = window.prompt('预设名称', `预设 ${presetsCache.length + 1}`);
  if (!name) return;
  void savePreset(name.trim() || '未命名', editor.toPreset(name)).then(async (record) => {
    activePresetId = record.id;
    await refreshPresets();
    toast('已保存预设');
  });
});

const presetImport = document.createElement('input');
presetImport.type = 'file';
presetImport.accept = '.json,application/json';
presetImport.hidden = true;
document.body.append(presetImport);

must<HTMLButtonElement>('#btn-preset-import').addEventListener('click', () => presetImport.click());
presetImport.addEventListener('change', () => {
  const file = presetImport.files?.[0];
  presetImport.value = '';
  if (!file) return;
  void file.text().then(async (text) => {
    let parsed: Preset | null = null;
    try {
      parsed = parsePreset(JSON.parse(text));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      showNotice('这不是有效的预设文件。', 'error', 6000);
      return;
    }
    const record = await savePreset(parsed.name, parsed);
    activePresetId = record.id;
    await refreshPresets();
    await applyPresetById(record.id);
  });
});

must<HTMLButtonElement>('#btn-preset-export').addEventListener('click', () => {
  const preset = editor.toPreset(presetsCache.find((p) => p.id === activePresetId)?.name ?? 'preset');
  download(
    new Blob([serializePreset(preset)], { type: 'application/json' }),
    `${preset.name}.json`,
  );
});

// ---------- 导出 ----------

btnExport.addEventListener('click', () => {
  if (!editor.loaded || busy) return;
  const token = ++loadToken;
  setBusy(true, '导出中…');
  void editor
    .exportJpeg()
    .then((result) => {
      if (token !== loadToken) return;
      if (!result.ok || !result.blob) {
        showNotice(result.error ?? '导出失败', 'error', 6000);
        return;
      }
      const base = editor.name.replace(/\.[^.]+$/, '') || 'photo';
      download(result.blob, `${base}_grain.jpg`);
      toast(result.downscaled ? '已导出（受显存限制缩小）' : '已导出');
    })
    .catch((err: unknown) => {
      showNotice(err instanceof Error ? err.message : String(err), 'error', 6000);
    })
    .finally(() => {
      if (token === loadToken) setBusy(false);
    });
});

// ---------- 快捷键 ----------

let compareBackup: { params: ReturnType<() => typeof editor.params>; curve: Float32Array } | null =
  null;

function startCompare(): void {
  if (!editor.loaded || compareBackup) return;
  compareBackup = { params: editor.params, curve: editor.curve };
  editor.setRaw({ ...IDENTITY }, identityCurve());
  toast('原图（松开返回）', 8000);
}

function endCompare(): void {
  if (!compareBackup) return;
  editor.setRaw(compareBackup.params, compareBackup.curve);
  compareBackup = null;
  hideNotice();
  toastEl.classList.add('hidden');
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) {
    // range / checkbox 不是文本输入，快捷键必须继续工作
    return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(target.type);
  }
  return false;
}

window.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    if (editor.undo()) toast('已撤销');
    return;
  }
  if (mod && e.key.toLowerCase() === 'z' && e.shiftKey) {
    e.preventDefault();
    editor.pushHistory();
    editor.reset();
    toast('已重置');
    return;
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    btnExport.click();
    return;
  }
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    fileInput.click();
    return;
  }
  if (e.key === 'Escape' && busy) {
    batchCancel = true;
    return;
  }
  if (e.key === '\\' && !e.repeat) startCompare();
});

window.addEventListener('keyup', (e) => {
  if (e.key === '\\') endCompare();
});

// 失焦时 keyup 会丢：必须主动恢复，否则画面会永远停在原图
window.addEventListener('blur', endCompare);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) endCompare();
});

// ---------- 风格 ----------

let lutsCache: StoredLut[] = [];
let activeLutId: string | null = null;

async function refreshLuts(): Promise<void> {
  lutsCache = await listLuts();
  renderChips(
    lutList,
    lutsCache.map((l) => ({ id: l.id, label: l.name })),
    {
      activeId: activeLutId,
      emptyHint: '还没有风格',
      onSelect: (id) => {
        void getLut(id).then((lut) => {
          if (!lut) return;
          editor.pushHistory();
          editor.setLut(lut.data, lut.size, lut.id);
          activeLutId = id;
          toast(`风格：${lut.name}`);
          void refreshLuts();
        });
      },
      onDelete: (id) => {
        if (!window.confirm('删除这个风格？')) return;
        void deleteLut(id).then(() => {
          if (activeLutId === id) {
            activeLutId = null;
            editor.setLut(null);
          }
          return refreshLuts();
        });
      },
    },
  );
}

const cubeImport = document.createElement('input');
cubeImport.type = 'file';
cubeImport.accept = '.cube,text/plain';
cubeImport.hidden = true;
document.body.append(cubeImport);

must<HTMLButtonElement>('#btn-lut-import').addEventListener('click', () => cubeImport.click());
cubeImport.addEventListener('change', () => {
  const file = cubeImport.files?.[0];
  cubeImport.value = '';
  if (!file) return;
  void file.text().then(async (text) => {
    try {
      const cube = parseCube(text);
      const data = resampleCube(cube, LUT_SIZE);
      const name = file.name.replace(/\.cube$/i, '');
      const record = await saveLut(name, LUT_SIZE, data);
      editor.pushHistory();
      editor.setLut(data, LUT_SIZE, record.id);
      activeLutId = record.id;
      await refreshLuts();
      toast(`已载入风格：${name}`);
    } catch (err) {
      showNotice(err instanceof Error ? err.message : String(err), 'error', 6000);
    }
  });
});

const refInput = document.createElement('input');
refInput.type = 'file';
refInput.accept = 'image/jpeg,image/png,.jpg,.jpeg,.png';
refInput.hidden = true;
document.body.append(refInput);

must<HTMLButtonElement>('#btn-lut-learn').addEventListener('click', () => {
  if (!editor.loaded) {
    toast('先打开一张要处理的照片');
    return;
  }
  refInput.click();
});
refInput.addEventListener('change', () => {
  const file = refInput.files?.[0];
  refInput.value = '';
  if (!file) return;
  void (async () => {
    toast('学习风格中…', 60000);
    try {
      const source = editor.renderedThumbnail(256);
      if (!source) throw new Error('当前图片不可用');
      const bitmap = await createImageBitmap(file);
      const reference = await thumbnail(bitmap, 256);
      bitmap.close();
      const data = buildLutFromReference(source, reference, 0.85);
      const name = window.prompt('给这个风格起个名字', '参考风格') || '参考风格';
      const record = await saveLut(name.slice(0, 20), LUT_SIZE, data);
      editor.pushHistory();
      editor.setLut(data, LUT_SIZE, record.id);
      activeLutId = record.id;
      await refreshLuts();
      toast('已生成风格');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : String(err), 'error', 6000);
    }
  })();
});

must<HTMLButtonElement>('#btn-lut-export').addEventListener('click', () => {
  const data = editor.lutData;
  if (!data) {
    toast('还没有选中任何风格');
    return;
  }
  const name = lutsCache.find((l) => l.id === activeLutId)?.name ?? 'grain';
  download(new Blob([serializeCube(data, LUT_SIZE, name)], { type: 'text/plain' }), `${name}.cube`);
});

// ---------- 启动 ----------

void refreshPresets();
void refreshLuts();
refresh();
editor.preloadFaceModel();

// ---------- 调试/测试入口 ----------

declare global {
  interface Window {
    __grain: {
      editor: Editor;
      loadBytes(name: string, bytes: number[], type?: string): Promise<void>;
      loadBase64(name: string, b64: string, type?: string): Promise<void>;
      stats(): unknown;
      identity(): Record<string, number>;
      identityCurve(): Float32Array;
      sourcePixels(): { width: number; height: number; data: Uint8ClampedArray };
      exportOnce(): Promise<{ ok: boolean; size: number; width?: number; height?: number; error?: string }>;
      exportBase64(): Promise<{ ok: boolean; b64: string; width: number; height: number; error?: string }>;
      applyCube(text: string): boolean;
      learnFromBase64(b64: string): Promise<boolean>;
      hasLut(): boolean;
      setRawParams(patch: Record<string, number>): void;
      checkGuard(): Promise<{ ok: boolean; note: string }>;
    };
  }
}

window.__grain = {
  editor,
  async loadBytes(name: string, bytes: number[], type = 'image/png'): Promise<void> {
    const file = new File([new Uint8Array(bytes)], name, { type });
    await editor.load(file);
  },
  async loadBase64(name: string, b64: string, type = 'image/png'): Promise<void> {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name, { type });
    await editor.load(file);
  },
  stats: () => editor.stats,
  identity: () => ({ ...IDENTITY }),
  identityCurve: () => identityCurve(),
  sourcePixels(): { width: number; height: number; data: Uint8ClampedArray } {
    const size = editor.size;
    if (!size) throw new Error('尚未载入图片');
    return { width: size.width, height: size.height, data: editor.renderer.readSource() };
  },
  async exportOnce() {
    const r = await editor.exportJpeg();
    return { ok: r.ok, size: r.blob?.size ?? 0, width: r.width, height: r.height, error: r.error };
  },
  async exportBase64() {
    const r = await editor.exportJpeg();
    if (!r.ok || !r.blob) return { ok: false, b64: '', width: 0, height: 0, error: r.error };
    const buf = new Uint8Array(await r.blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 8192) {
      bin += String.fromCharCode(...buf.subarray(i, i + 8192));
    }
    return { ok: true, b64: btoa(bin), width: r.width ?? 0, height: r.height ?? 0 };
  },
  applyCube(text: string): boolean {
    try {
      const data = resampleCube(parseCube(text), LUT_SIZE);
      editor.setLut(data, LUT_SIZE, 'test');
      return true;
    } catch (err) {
      console.warn(err);
      return false;
    }
  },
  async learnFromBase64(b64: string): Promise<boolean> {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const source = editor.renderedThumbnail(256);
    const reference = await thumbnail(bitmap, 256);
    bitmap.close();
    if (!source) return false;
    editor.setLut(buildLutFromReference(source, reference, 0.85), LUT_SIZE, 'learned');
    return true;
  },
  hasLut: () => editor.lutData !== null,
  setRawParams(patch: Record<string, number>): void {
    editor.setRaw({ ...editor.params, ...patch } as typeof editor.params, editor.curve);
  },
  checkGuard: () => editor.checkGuardNow(),
};