/**
 * 六根滑杆。纯展示 + 事件上抛，不持有业务状态。
 */

import { SLIDER_IDS, type SliderId } from '../core/types';

const LABELS: Record<SliderId, string> = {
  bright: '亮',
  warm: '暖',
  rich: '浓',
  clean: '净',
  soft: '软',
  style: '风格',
};

export interface SliderHandle {
  set(value: number): void;
  setDisabled(disabled: boolean): void;
}

export function mountSliders(
  container: HTMLElement,
  onChange: (id: SliderId, value: number) => void,
): Record<SliderId, SliderHandle> {
  const handles = {} as Record<SliderId, SliderHandle>;
  container.textContent = '';

  for (const id of SLIDER_IDS) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    wrap.dataset.slider = id;

    const head = document.createElement('div');
    head.className = 'slider-head';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = LABELS[id];
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = '0';
    head.append(name, val);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = '-100';
    input.max = '100';
    input.step = '1';
    input.value = '0';
    // 读屏需要名字，否则只会念 "slider 0"
    input.setAttribute('aria-label', `${LABELS[id]}（-100 到 100）`);
    input.setAttribute('aria-valuetext', '0');

    input.addEventListener('input', () => {
      const v = Number(input.value);
      val.textContent = String(v);
      input.setAttribute('aria-valuetext', String(v));
      onChange(id, v);
    });
    // 双击归零（符合绘图软件习惯）
    input.addEventListener('dblclick', () => {
      input.value = '0';
      val.textContent = '0';
      input.setAttribute('aria-valuetext', '0');
      onChange(id, 0);
    });

    wrap.append(head, input);
    container.append(wrap);

    handles[id] = {
      set(value: number): void {
        input.value = String(value);
        val.textContent = String(value);
        input.setAttribute('aria-valuetext', String(value));
      },
      setDisabled(disabled: boolean): void {
        input.disabled = disabled;
        wrap.classList.toggle('disabled', disabled);
        if (disabled) input.setAttribute('aria-disabled', 'true');
        else input.removeAttribute('aria-disabled');
        wrap.title = disabled ? '选择或导入风格后可用' : '';
      },
    };
  }

  return handles;
}