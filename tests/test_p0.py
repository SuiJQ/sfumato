"""P0 验收：构建产物能加载、WebGL2 可用、渲染循环在跑、无控制台错误。"""

from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))
from harness import report, serve, session  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def main() -> int:
    ok = True
    srv = serve(DIST)
    try:
        with session() as s:
            s.goto(srv.url)
            s.page.wait_for_timeout(600)

            gl_info = s.page.evaluate(
                """() => {
                    const c = document.querySelector('#view');
                    const gl = c.getContext('webgl2');
                    if (!gl) return { ok: false };
                    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
                    return {
                        ok: true,
                        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                        version: gl.getParameter(gl.VERSION),
                        maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
                    };
                }"""
            )
            ok &= report("WebGL2 可用", bool(gl_info.get("ok")), str(gl_info))
            ok &= report("无控制台错误", not s.errors, "; ".join(s.errors[:3]))

            # 空状态：欢迎文案可见、画布已创建、导出按钮禁用
            empty_visible = s.page.evaluate(
                "() => !document.querySelector('#empty').classList.contains('hidden')"
            )
            export_disabled = s.page.evaluate(
                "() => document.querySelector('#btn-export').disabled"
            )
            ok &= report("空状态可见", empty_visible is True)
            ok &= report("未载图时导出按钮禁用", export_disabled is True)
            ok &= report("滑杆已挂载六根", len(s.page.query_selector_all(".slider input")) == 6)

            shot = ROOT / "tests" / "out" / "p0.png"
            shot.parent.mkdir(exist_ok=True)
            s.page.screenshot(path=str(shot))
    finally:
        srv.close()
    print("\nP0:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())