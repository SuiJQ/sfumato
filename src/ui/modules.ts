/**
 * 可选项开关。
 *
 * 三个状态必须能被看见：
 *   可用 / 不可用（画面里没有这类内容）
 *   自动 / 手动（用户点过之后规则表不再改写）
 */

import { MODULE_IDS, type ModuleId, type Modules } from '../core/types';

const LABELS: Record<ModuleId, string> = {
  portrait: '人像优化',
  sky: '天空增强',
  foliage: '绿植优化',
  dehaze: '去灰',
  film: '胶片感',
  night: '夜景提亮',
};

export interface ModuleHandle {
  set(enabled: boolean): void;
  setAvailable(available: boolean): void;
  setHint(text: string): void;
  setLocked(locked: boolean): void;
}

export function mountModules(
  container: HTMLElement,
  onChange: (id: ModuleId, enabled: boolean) => void,
): Record<ModuleId, ModuleHandle> {
  const handles = {} as Record<ModuleId, ModuleHandle>;
  container.textContent = '';

  for (const id of MODULE_IDS) {
    const row = document.createElement('label');
    row.className = 'module';
    row.dataset.module = id;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('aria-label', LABELS[id]);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = LABELS[id];

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '自动';

    input.addEventListener('change', () => onChange(id, input.checked));

    row.append(input, name, hint);
    container.append(row);

    handles[id] = {
      set(enabled: boolean): void {
        input.checked = enabled;
      },
      setAvailable(available: boolean): void {
        input.disabled = !available;
        row.classList.toggle('unavailable', !available);
        row.title = available ? '双击恢复自动判断' : '画面中没有可处理的内容';
      },
      setHint(text: string): void {
        hint.textContent = text;
      },
      setLocked(locked: boolean): void {
        row.classList.toggle('locked', locked);
      },
    };
  }

  return handles;
}

export function syncModules(handles: Record<ModuleId, ModuleHandle>, modules: Modules): void {
  for (const id of MODULE_IDS) handles[id].set(modules[id]);
}