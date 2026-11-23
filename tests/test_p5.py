"""P5 验收：守门员真的会回退、位图真的被释放、快捷键生效、性能采样有值。

守门员只测"不触发"是没有意义的，必须构造一个必然翻车的输入。
"""

from __future__ import annotations

import base64
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import report, serve, session  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
ASSETS = ROOT / "tests" / "assets"
OUT = ROOT / "tests" / "out"


def b64(p: Path) -> str:
    return base64.b64encode(p.read_bytes()).decode()


def set_slider(s, index: int, value: int) -> None:
    s.page.evaluate(
        """({i, v}) => {
            const input = document.querySelectorAll('.slider input')[i];
            input.value = String(v);
            input.dispatchEvent(new Event('input', {bubbles: true}));
        }""",
        {"i": index, "v": value},
    )


def main() -> int:
    ok = True
    OUT.mkdir(exist_ok=True)
    srv = serve(DIST)
    try:
        with session() as s:
            s.goto(srv.url)
            s.page.wait_for_timeout(250)
            s.page.evaluate(
                "async ({d}) => { await window.__grain.loadBase64('a.png', d, 'image/png'); }",
                {"d": b64(ASSETS / "p1_before.png")},
            )
            s.page.wait_for_timeout(900)

            # --- 默认参数不应触发守门 ---
            note = s.page.evaluate("() => window.__grain.editor.guardNote")
            ok &= report("默认参数不触发守门", note == "", f"note='{note}'")

            # --- 极端参数：必须触发并收敛 ---
            # 滑杆到顶也不一定翻车（这正是万金油设计目标），所以这里注入
            # 一组"必然过曝"的参数，验证守门员本身是否真的会拦。
            verdict = s.page.evaluate(
                """() => {
                    const g = window.__grain;
                    g.setRawParams({ ev: 3.0, sat: 2.6, lcGain: 1.8, sharpenAmt: 1.2 });
                    return g.checkGuard();
                }"""
            )
            ok &= report("极端参数触发守门", verdict["ok"] is False, f"note='{verdict['note']}'")
            ok &= report(
                "守门说明指向具体原因",
                any(k in verdict["note"] for k in ("高光", "暗部", "对比度", "噪点", "收敛")),
                verdict["note"],
            )
            s.page.wait_for_timeout(400)
            ev_after = s.page.evaluate("() => window.__grain.editor.params.ev")
            ok &= report("回退后强度确实下降", ev_after < 1.5, f"ev={ev_after:.2f}")

            # 收敛后画面不应仍然过曝：检查高光裁切率
            clip = s.page.evaluate(
                """() => {
                    const g = window.__grain;
                    const s = g.editor.size;
                    const w = 256, h = Math.round(256 * s.height / s.width);
                    const px = g.editor.renderPixels(w, h, g.editor.params, g.editor.curve);
                    let hi = 0, n = w * h;
                    for (let i = 0; i < px.length; i += 4) {
                        if (px[i] >= 250 || px[i+1] >= 250 || px[i+2] >= 250) hi++;
                    }
                    return hi / n;
                }"""
            )
            ok &= report("守门后高光未爆", clip < 0.06, f"clip={clip:.4f}")

            # --- 位图释放：换图后旧 bitmap 必须被 close() ---
            first = s.page.evaluate(
                """() => {
                    const b = window.__grain.editor.currentBitmap;
                    window.__bmp1 = b;
                    return b.width;
                }"""
            )
            ok &= report("换图前位图有效", first == 688, f"width={first}")
            s.page.evaluate(
                "async ({d}) => { await window.__grain.loadBase64('b.png', d, 'image/png'); }",
                {"d": b64(ASSETS / "p2_before.png")},
            )
            s.page.wait_for_timeout(600)
            first_after = s.page.evaluate("() => window.__bmp1.width")
            ok &= report("旧位图已被释放", first_after == 0, f"width={first_after}")

            # --- 快捷键：滑杆聚焦时仍可用（之前被 typing 判断误伤） ---
            s.page.evaluate(
                """() => {
                    const i = document.querySelectorAll('.slider input')[0];
                    i.focus();
                    window.__grain.editor.pushHistory();
                    i.value = '55';
                    i.dispatchEvent(new Event('input', {bubbles:true}));
                }"""
            )
            s.page.wait_for_timeout(120)
            before = s.page.evaluate("() => window.__grain.editor.sliders.bright")
            s.page.keyboard.press("Control+z")
            s.page.wait_for_timeout(250)
            after = s.page.evaluate("() => window.__grain.editor.sliders.bright")
            ok &= report("Ctrl+Z 撤销（滑杆聚焦时依然生效）", before == 55 and after == 0, f"{before} → {after}")

            # --- 性能采样 ---
            perf = s.page.evaluate("() => window.__grain.editor.perf")
            ok &= report("加载耗时被记录", perf["loadMs"] > 0, str(perf))
            s.page.evaluate("() => window.__grain.exportOnce()")
            perf2 = s.page.evaluate("() => window.__grain.editor.perf")
            ok &= report("导出耗时被记录", perf2["exportMs"] > 0, str(perf2))

            # --- 连续载入不崩 ---
            for i in range(3):
                s.page.evaluate(
                    "async ({d, n}) => { await window.__grain.loadBase64('c'+n+'.png', d, 'image/png'); }",
                    {"d": b64(ASSETS / ("p1_before.png" if i % 2 == 0 else "p2_before.png")), "n": i},
                )
                s.page.wait_for_timeout(250)
            alive = s.page.evaluate("() => window.__grain.editor.loaded")
            ok &= report("连续切换 3 次仍可用", alive is True)

            s.page.screenshot(path=str(OUT / "p5_guard.png"))
            ok &= report("无控制台错误", not s.errors, "; ".join(s.errors[:3]))
    finally:
        srv.close()

    print("\nP5:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())