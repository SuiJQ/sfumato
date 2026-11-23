"""P6 验收：FaceMesh 接入是否真的产生效果。

只断言"检测到 1 张脸"是不够的——必须证明：
  1) 眼睛通道有非零权重
  2) 眼神光参数确实只作用在眼睛区域
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

EYE_EFFECT = """
() => {
  const g = window.__grain;
  const eye = g.editor.eyeInfo;
  if (!eye) return { none: true };
  const w = eye.width, h = eye.height;
  const on  = g.editor.renderPixels(w, h, { ...g.editor.params, lumaEye: 0.08 }, g.editor.curve);
  const off = g.editor.renderPixels(w, h, { ...g.editor.params, lumaEye: 0    }, g.editor.curve);

  let eyeSum = 0, eyeN = 0, allSum = 0, allN = 0, eyePixels = 0;
  for (let i = 0; i < w * h; i++) {
    const wgt = eye.data[i * 4];
    const d = Math.abs(on[i * 4] - off[i * 4]) + Math.abs(on[i * 4 + 1] - off[i * 4 + 1]);
    allSum += d; allN++;
    if (wgt > 128) { eyeSum += d; eyeN++; eyePixels++; }
  }
  return {
    eyeMean: eyeN ? eyeSum / eyeN : 0,
    allMean: allSum / allN,
    coverage: eyePixels / (w * h),
    w, h,
  };
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
            s.page.wait_for_timeout(300)
            s.page.evaluate(
                "async ({d}) => { await window.__grain.loadBase64('p.png', d, 'image/png'); }",
                {"d": b64(ASSETS / "p1_before.png")},
            )

            state = {}
            for _ in range(60):
                time.sleep(0.5)
                state = s.page.evaluate(
                    """() => ({
                        q: window.__grain.editor.maskQuality,
                        face: window.__grain.editor.stats.face,
                        hasEye: !!window.__grain.editor.eyeInfo,
                        mods: window.__grain.editor.modules,
                    })"""
                )
                if state["q"] != "none":
                    break

            ok &= report("全图检出人脸", state["face"]["count"] >= 1, str(state["face"]))
            ok &= report("生成眼睛权重图", state["hasEye"] is True)
            ok &= report("人像模块自动开启", state["mods"]["portrait"] is True)

            eff = s.page.evaluate(EYE_EFFECT)
            ok &= report(
                "眼睛权重有明确峰值（面积随人脸大小变化）",
                0 < eff["coverage"] < 0.1,
                f"coverage={eff['coverage']:.5f} ({eff['w']}×{eff['h']})",
            )
            ok &= report(
                "眼神光只作用在眼睛区域",
                eff["eyeMean"] > 0.8 and eff["eyeMean"] > eff["allMean"] * 3,
                f"eyeMean={eff['eyeMean']:.2f} allMean={eff['allMean']:.2f}",
            )

            s.page.screenshot(path=str(OUT / "p6_face.png"))
            ok &= report("无控制台错误", not s.errors, "; ".join(s.errors[:3]))
    finally:
        srv.close()

    print("\nP6:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())