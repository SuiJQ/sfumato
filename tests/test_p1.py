"""P1 验收：恒等性、万金油行为、渲染稳定性。

零信任原则：不假设"看起来对"，全部用像素与统计量验证。
"""

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

IDENTITY_SCRIPT = """
() => {
  const g = window.__grain;
  const src = g.sourcePixels();
  const out = g.editor.renderPixels(src.width, src.height, g.identity(), g.identityCurve());
  let max = 0, sum = 0, cnt = 0, over1 = 0, alphaBad = 0;
  for (let i = 0; i < src.data.length; i += 4) {
    if (out[i + 3] !== 255) alphaBad++;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(src.data[i + c] - out[i + c]);
      sum += d;
      if (d > max) max = d;
      if (d > 1) over1++;
      cnt++;
    }
  }
  // 恢复预览用的自适应曲线
  g.editor.renderer.setCurve(g.editor.curve);
  return { max, mean: sum / cnt, over1, alphaBad, w: src.width, h: src.height };
}
"""

STATS_SCRIPT = """
() => {
  const g = window.__grain;
  const size = g.editor.size;
  const w = Math.min(512, size.width), h = Math.round(w * size.height / size.width);
  const src = g.sourcePixels();
  const out = g.editor.renderPixels(w, h, g.editor.params, g.editor.curve);

  const measure = (arr, width, height) => {
    let s = 0, hi = 0, lo = 0, n = width * height;
    for (let i = 0; i < arr.length; i += 4) {
      const r = arr[i], gg = arr[i + 1], b = arr[i + 2];
      s += (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
      if (r >= 250 || gg >= 250 || b >= 250) hi++;
      if (r <= 5 && gg <= 5 && b <= 5) lo++;
    }
    return { mean: s / n, hi: hi / n, lo: lo / n };
  };
  return { src: measure(src.data, src.width, src.height), out: measure(out, w, h), params: g.editor.params, stats: g.editor.stats };
}
"""


def b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode()


def main() -> int:
    ok = True
    OUT.mkdir(exist_ok=True)
    srv = serve(DIST)
    try:
        with session() as s:
            s.goto(srv.url)
            s.page.wait_for_timeout(300)

            # --- 载入样张 ---
            data = b64(ASSETS / "p1_before.png")
            s.page.evaluate(
                """async ({name, data}) => { await window.__grain.loadBase64(name, data, 'image/png'); }""",
                {"name": "p1_before.png", "data": data},
            )
            s.page.wait_for_timeout(400)
            ok &= report("样张载入", s.page.evaluate("() => window.__grain.editor.loaded"))
            ok &= report("无控制台错误（载入）", not s.errors, "; ".join(s.errors[:2]))

            # --- 恒等性 ---
            ident = s.page.evaluate(IDENTITY_SCRIPT)
            s.page.wait_for_timeout(100)
            ok &= report(
                "恒等性 max|Δ| ≤ 1",
                ident["max"] <= 1,
                f"max={ident['max']} mean={ident['mean']:.4f} over1={ident['over1']} size={ident['w']}x{ident['h']}",
            )
            ok &= report("输出 alpha 全不透明", ident["alphaBad"] == 0, f"bad={ident['alphaBad']}")

            # --- 万金油 ---
            m = s.page.evaluate(STATS_SCRIPT)
            before, after, params, stats = m["src"], m["out"], m["params"], m["stats"]
            ok &= report(
                "万金油改变画面",
                abs(after["mean"] - before["mean"]) > 0.005,
                f"mean {before['mean']:.3f} → {after['mean']:.3f}",
            )
            ok &= report(
                "曝光朝中灰收敛",
                abs(after["mean"] - 0.5) <= abs(before["mean"] - 0.5) + 0.02,
                f"|Δ中灰| {abs(before['mean'] - 0.5):.3f} → {abs(after['mean'] - 0.5):.3f}",
            )
            ok &= report(
                "高光不被切爆",
                after["hi"] < max(0.02, before["hi"] * 1.5),
                f"clip.hi {before['hi']:.4f} → {after['hi']:.4f}",
            )
            ok &= report(
                "阴影不死黑",
                after["lo"] <= max(0.02, before["lo"] * 1.2),
                f"clip.lo {before['lo']:.4f} → {after['lo']:.4f}",
            )
            ok &= report(
                "曝光补偿在合理区间",
                abs(params["ev"]) <= 0.9,
                f"ev={params['ev']:.3f} knee={params['knee']:.2f} sat={params['sat']:.2f} s={stats.get('noise', {}).get('sigma', 0):.4f}",
            )

            # --- 视觉留档 ---
            s.page.screenshot(path=str(OUT / "p1_after.png"))

            s.page.evaluate(
                """() => { const g = window.__grain; g.editor.setRaw(g.identity(), g.identityCurve()); }"""
            )
            s.page.wait_for_timeout(120)
            s.page.screenshot(path=str(OUT / "p1_before.png"))

            ok &= report("全程无控制台错误", not s.errors, "; ".join(s.errors[:3]))
    finally:
        srv.close()

    print("\nP1:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())