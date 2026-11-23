"""P3 验收：分析 Worker、mask 质量、区域效果是否真的生效。"""

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


def wait_mask(s, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = s.page.evaluate(
            """() => ({
                q: window.__grain.editor.maskQuality,
                ms: window.__grain.editor.analysisMs,
                r: window.__grain.editor.stats.regions,
                mods: window.__grain.editor.modules,
            })"""
        )
        if state["q"] != "none":
            return state
        time.sleep(0.4)
    return state


def main() -> int:
    ok = True
    OUT.mkdir(exist_ok=True)
    srv = serve(DIST)
    try:
        with session() as s:
            s.goto(srv.url)
            s.page.wait_for_timeout(250)
            s.page.evaluate(
                "async ({d}) => { await window.__grain.loadBase64('portrait.png', d, 'image/png'); }",
                {"d": b64(ASSETS / "p1_before.png")},
            )
            state = wait_mask(s)
            ok &= report("使用分割模型", state["q"] == "model", f"quality={state['q']} ms={state['ms']}")
            ok &= report(
                "检测到人像区域",
                state["r"]["person"] > 0.02,
                f"person={state['r']['person']:.3f}",
            )
            ok &= report(
                "检测到皮肤区域",
                state["r"]["skin"] > 0.005,
                f"skin={state['r']['skin']:.3f}",
            )
            ok &= report(
                "人像模块被规则表自动开启",
                state["mods"]["portrait"] is True,
                str(state["mods"]),
            )

            # 关掉人像模块后，画面应当发生变化（说明区域增益真的生效）
            # 只在"区域权重覆盖到的地方"比较：全图均值会被大面积背景稀释，
            # 掩盖模块其实生效/没生效
            diff = s.page.evaluate(
                """() => {
                    const g = window.__grain, e = g.editor;
                    const s = e.size, w = 320, h = Math.round(320 * s.height / s.width);
                    const on = e.renderPixels(w, h, e.params, e.curve);
                    e.setModule('portrait', false);
                    e.setModule('sky', false);
                    const off = e.renderPixels(w, h, e.params, e.curve);
                    e.setModule('portrait', true);
                    e.setModule('sky', true);

                    const mi = e.maskInfo;
                    let sum = 0, n = 0;
                    for (let y = 0; y < h; y++) {
                      for (let x = 0; x < w; x++) {
                        const mx = Math.min(mi.width - 1, Math.floor(x / w * mi.width));
                        const my = Math.min(mi.height - 1, Math.floor(y / h * mi.height));
                        const mi4 = (my * mi.width + mx) * 4;
                        const wgt = Math.max(mi.data[mi4 + 1], mi.data[mi4 + 2]) / 255; // 皮肤 / 天空
                        if (wgt < 0.5) continue;
                        const i = (y * w + x) * 4;
                        sum += (Math.abs(on[i]-off[i]) + Math.abs(on[i+1]-off[i+1]) + Math.abs(on[i+2]-off[i+2])) / 3;
                        n++;
                      }
                    }
                    return n ? sum / n : 0;
                }"""
            )
            ok &= report("区域增益改变了画面（区域内）", diff > 1.0, f"meanΔ={diff:.2f}")

            s.page.wait_for_timeout(200)
            s.page.screenshot(path=str(OUT / "p3_portrait.png"))

            # 第二张：天空占比高的场景
            s.page.evaluate(
                "async ({d}) => { await window.__grain.loadBase64('sky.png', d, 'image/png'); }",
                {"d": b64(ASSETS / "p2_before.png")},
            )
            state2 = wait_mask(s)
            ok &= report(
                "天空占比识别",
                state2["r"]["sky"] > 0.1,
                f"sky={state2['r']['sky']:.3f}",
            )
            ok &= report(
                "天空模块自动开启",
                state2["mods"]["sky"] is True,
                str(state2["mods"]),
            )
            s.page.wait_for_timeout(200)
            s.page.screenshot(path=str(OUT / "p3_sky.png"))

            ok &= report("无控制台错误", not s.errors, "; ".join(s.errors[:3]))
    finally:
        srv.close()

    print("\nP3:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())