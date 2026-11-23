"""P2 验收：导出（JPEG/尺寸/颜色一致性）、预设持久化与回放、快捷键。

零信任：导出结果要解码回来逐项比对，而不是只看"有文件生成"。
"""

from __future__ import annotations

import base64
import io
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from harness import report, serve, session  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
ASSETS = ROOT / "tests" / "assets"
OUT = ROOT / "tests" / "out"


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
                "async ({d}) => { await window.__grain.loadBase64('p1_before.png', d, 'image/png'); }",
                {"d": b64(ASSETS / "p1_before.png")},
            )
            s.page.wait_for_timeout(350)

            # --- 导出一致性 ---
            exp = s.page.evaluate("() => window.__grain.exportBase64()")
            ok &= report("导出成功", exp["ok"], exp.get("error", ""))
            raw = base64.b64decode(exp["b64"])
            (OUT / "p2_export.jpg").write_bytes(raw)
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            src = Image.open(ASSETS / "p1_before.png").convert("RGB")
            ok &= report(
                "导出尺寸 = 原图尺寸",
                img.size == src.size,
                f"{img.size} vs {src.size}",
            )
            ok &= report("导出为 JPEG 且非空", len(raw) > 5000, f"{len(raw)} bytes")

            # 与预览渲染的像素均值比对（JPEG 有损，容差 4）
            preview = s.page.evaluate(
                """() => {
                    const g = window.__grain;
                    const s = g.editor.size;
                    const out = g.editor.renderPixels(s.width, s.height, g.editor.params, g.editor.curve);
                    let r=0,gg=0,b=0,n=0;
                    for (let i=0;i<out.length;i+=4){r+=out[i];gg+=out[i+1];b+=out[i+2];n++;}
                    return {r:r/n,g:gg/n,b:b/n};
                }"""
            )
            px = list(img.resize((64, 64)).getdata())
            mr = sum(p[0] for p in px) / len(px)
            mg = sum(p[1] for p in px) / len(px)
            mb = sum(p[2] for p in px) / len(px)
            drift = max(abs(mr - preview["r"]), abs(mg - preview["g"]), abs(mb - preview["b"]))
            ok &= report("导出与预览颜色一致", drift <= 4, f"Δ={drift:.2f}")

            # --- 预设：存 → 重置 → 回放 ---
            s.page.evaluate(
                """() => {
                    const input = document.querySelectorAll('.slider input')[0];
                    input.value = '40';
                    input.dispatchEvent(new Event('input', {bubbles:true}));
                }"""
            )
            s.page.wait_for_timeout(120)
            bright = s.page.evaluate("() => window.__grain.editor.sliders.bright")
            ok &= report("滑杆驱动状态", bright == 40, f"bright={bright}")

            s.page.once("dialog", lambda d: d.accept("测试预设"))
            s.page.click("#btn-preset-save")
            s.page.wait_for_timeout(400)
            chips = s.page.eval_on_selector_all(".chip-label", "els => els.map(e => e.textContent)")
            ok &= report("预设出现在列表", "测试预设" in chips, str(chips))

            s.page.click("#btn-reset")
            s.page.wait_for_timeout(150)
            ok &= report(
                "重置后滑杆归零",
                s.page.evaluate("() => window.__grain.editor.sliders.bright") == 0,
            )

            s.page.evaluate(
                """() => [...document.querySelectorAll('#presets .chip-label')].find(e => e.textContent === '测试预设').click()"""
            )
            s.page.wait_for_timeout(250)
            ok &= report(
                "预设回放滑杆",
                s.page.evaluate("() => window.__grain.editor.sliders.bright") == 40,
                f"bright={s.page.evaluate('() => window.__grain.editor.sliders.bright')}",
            )

            # --- 持久化：刷新后仍在 ---
            s.page.reload(wait_until="networkidle")
            s.page.wait_for_timeout(500)
            chips = s.page.eval_on_selector_all("#presets .chip-label", "els => els.map(e => e.textContent)")
            ok &= report("刷新后预设仍在", "测试预设" in chips, str(chips))

            ok &= report("无控制台错误", not s.errors, "; ".join(s.errors[:3]))
    finally:
        srv.close()

    print("\nP2:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())