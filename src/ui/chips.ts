/**
 * 通用 chip 列表（预设 / 风格共用）。只负责渲染与事件上抛。
 *
 * 删除入口必须是可见的：右键菜单在触屏和键盘上都不存在。
 */

export interface ChipItem {
  id: string;
  label: string;
}

export interface ChipOptions {
  activeId?: string | null;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  emptyHint?: string;
}

export function renderChips(container: HTMLElement, items: ChipItem[], opts: ChipOptions): void {
  container.textContent = '';

  if (items.length === 0 && opts.emptyHint) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = opts.emptyHint;
    container.append(hint);
    return;
  }

  for (const item of items) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    if (item.id === opts.activeId) chip.classList.add('active');

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'chip-label';
    label.textContent = item.label;
    label.setAttribute('aria-pressed', item.id === opts.activeId ? 'true' : 'false');
    label.addEventListener('click', () => opts.onSelect(item.id));
    chip.append(label);

    if (opts.onDelete) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chip-del';
      del.textContent = '×';
      del.setAttribute('aria-label', `删除 ${item.label}`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onDelete?.(item.id);
      });
      chip.append(del);
    }

    container.append(chip);
  }
}