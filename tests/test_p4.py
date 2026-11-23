"""P4 验收：.cube 解析/重采样、风格强度语义、从参考图学风格的有效性。"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import report, serve, session  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
ASSETS = ROOT / "tests" / "assets"
OUT = ROOT / "tests" / "out"

MEASURE = """
(dummy) => {
  const g = window.__grain;
  const s = g.editor.size;
  const w = 256, h = Math.round(256 * s.height / s.width);
  const px = g.editor.renderPixels(w, h, g.editor.params, g.editor.curve);
  let r=0,gg=0,b=0,n=0, maxd=0;
  for (let i=0;i<px.length;i+=4){ r+=px[i]; gg+=px[i+1]; b+=px[i+2]; n++; }
  return {r:r/n, g:gg/n, b:b/n, w, h};
}
"""


def b64(p: Path) -> str:
    return base64.b64encode(p.read_bytes()).decode()


def main() -> int:
    ok = True
    OUT.mkdir(exist_ok=True)
    srv = serve(DIST)
    try:
        with session() as s:
            s.goto(srv.url)
            s.page.wait_for_timeout(250)
            s.page.evaluate(
                "async ({d}) => { await window.__grain.loadBase64('p.png', d, 'image/png'); }",
                {"d": b64(ASSETS / "p1_before.png")},
            )
            s.page.wait_for_timeout(600)

            base = s.page.evaluate(MEASURE, None)

            # --- 恒等 LUT：不应改变画面 ---
            ok &= report(
                "恒等 cube 解析成功",
                s.page.evaluate("(t) => window.__grain.applyCube(t)", (ASSETS / 'identity.cube').read_text()),
            )
            s.page.wait_for_timeout(200)
            ident = s.page.evaluate(MEASURE, None)
            d = max(abs(ident[k] - base[k]) for k in 'rgb')
            ok &= report("恒等 LUT 不改变画面", d <= 2.0, f"Δ={d:.2f}")

            # --- 偏暖 LUT：红升蓝降 ---
            ok &= report(
                "偏暖 cube 解析成功",
                s.page.evaluate("(t) => window.__grain.applyCube(t)", (ASSETS / 'warm.cube').read_text()),
            )
            s.page.wait_for_timeout(200)
            warm = s.page.evaluate(MEASURE, None)
            ok &= report(
                "偏暖 LUT 方向正确",
                warm["r"] > base["r"] + 1 and warm["b"] < base["b"] - 1,
                f"R {base['r']:.1f}→{warm['r']:.1f}  B {base['b']:.1f}→{warm['b']:.1f}",
            )

            # --- 风格强度 0 时严格无效 ---
            s.page.evaluate(
                """() => {
                    const input = document.querySelectorAll('.slider input')[5];
                    input.value = '0';
                    input.dispatchEvent(new Event('input', {bubbles:true}));
                }"""
            )
            s.page.wait_for_timeout(200)
            zero = s.page.evaluate(MEASURE, None)
            d0 = max(abs(zero[k] - base[k]) for k in 'rgb')
            ok &= report("风格强度 0 = 无效果", d0 <= 2.0, f"Δ={d0:.2f}")

            # --- 从参考图学习 ---
            learned = s.page.evaluate(
                "async (d) => await window.__grain.learnFromBase64(d)",
                b64(ASSETS / "p1_after.png"),
            )
            ok &= report("参考图学习成功", learned is True)
            s.page.wait_for_timeout(300)
            styled = s.page.evaluate(MEASURE, None)
            moved = max(abs(styled[k] - base[k]) for k in 'rgb')
            ok &= report("学习后的 LUT 改变画面", moved > 2, f"Δ={moved:.2f}")

            s.page.screenshot(path=str(OUT / "p4_style.png"))
            ok &= report("无控制台错误", not s.errors, "; ".join(s.errors[:3]))
    finally:
        srv.close()

    print("\nP4:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())