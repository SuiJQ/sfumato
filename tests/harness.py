"""Playwright 测试基础设施：静态服务 + Chromium（SwiftShader 软渲染 WebGL2）。"""

from __future__ import annotations

import contextlib
import functools
import http.server
import socket
import socketserver
import threading
from dataclasses import dataclass
from pathlib import Path

from playwright.sync_api import Browser, Page, sync_playwright

CHROME_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-dev-shm-usage",
    "--no-sandbox",
]

# 环境里有系统 chromium 时优先用它，避免 Playwright 自带浏览器缺失
_SYS_CHROME = Path("/usr/bin/chromium")
CHROME_PATH = str(_SYS_CHROME) if _SYS_CHROME.exists() else None


def _free_port() -> int:
    with contextlib.closing(socket.socket()) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class Server:
    url: str
    _httpd: socketserver.TCPServer

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


def serve(directory: Path | str) -> Server:
    directory = str(directory)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    handler.log_message = lambda *a, **k: None  # type: ignore[attr-defined]
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return Server(f"http://127.0.0.1:{port}/", httpd)


class Session:
    """一次测试会话：浏览器 + 页面 + 控制台日志。"""

    def __init__(self, pw, headless: bool = True):
        self.browser: Browser = pw.chromium.launch(
            headless=headless, args=CHROME_ARGS, executable_path=CHROME_PATH
        )
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 900})
        self.page: Page = self.context.new_page()
        self.logs: list[str] = []
        self.errors: list[str] = []
        self.page.on("console", self._on_console)
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))

    # MediaPipe / TFLite 会把 INFO 级别打到 stderr，浏览器当 console.error 收，
    # 这不是错误，必须过滤，否则每次验收都被它污染。
    BENIGN = (
        "XNNPACK delegate",
        "INFO: Created TensorFlow Lite",
        "FaceBlendshapesGraph",
    )

    def _on_console(self, msg) -> None:
        line = f"[{msg.type}] {msg.text}"
        self.logs.append(line)
        if msg.type == "error" and not any(k in msg.text for k in self.BENIGN):
            self.errors.append(line)

    def goto(self, url: str) -> None:
        self.page.goto(url, wait_until="networkidle")

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.browser.close()


@contextlib.contextmanager
def session(headless: bool = True):
    with sync_playwright() as pw:
        s = Session(pw, headless=headless)
        try:
            yield s
        finally:
            s.close()


def report(name: str, ok: bool, detail: str = "") -> bool:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  · ' + detail) if detail else ''}")
    return ok