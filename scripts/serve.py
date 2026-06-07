#!/usr/bin/env python3
"""
Local dev server for the portfolio static site.

Serves files from the project root and proxies GET /api/daily-quote to ZenQuotes
so the browser quote gate works (zenquotes.io does not send CORS headers).

Usage:
  python3 scripts/serve.py
  python3 scripts/serve.py 8080
"""

from __future__ import annotations

import json
import sys
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ZENQUOTES_TODAY = "https://zenquotes.io/api/today"


class PortfolioHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/api/daily-quote":
            self._handle_daily_quote()
            return
        super().do_GET()

    def do_OPTIONS(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/api/daily-quote":
            self.send_response(204)
            self._send_cors_headers()
            self.end_headers()
            return
        super().do_OPTIONS()

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, apikey, Authorization")

    def _handle_daily_quote(self) -> None:
        try:
            req = urllib.request.Request(
                ZENQUOTES_TODAY,
                headers={"Accept": "application/json", "User-Agent": "PortfolioDevServer/1.0"},
            )
            with urllib.request.urlopen(req, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as error:  # noqa: BLE001
            body = json.dumps({"error": str(error)}).encode("utf-8")
            self.send_response(502)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
            return

        first = payload[0] if isinstance(payload, list) and payload else {}
        text = str(first.get("q", "")).strip()
        author = str(first.get("a", "")).strip()

        if not text:
            body = json.dumps({"error": "Quote payload missing text"}).encode("utf-8")
            self.send_response(502)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
            return

        body = json.dumps(
            {
                "text": text,
                "author": author or "Unknown",
                "date": first.get("date"),
                "source": "zenquotes.io",
            }
        ).encode("utf-8")

        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        request_line = args[0] if args else ""
        if "/api/daily-quote" in str(request_line):
            sys.stderr.write("[quote-proxy] %s\n" % (format % args))
        else:
            super().log_message(format, *args)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(("", port), PortfolioHandler)
    print(f"Serving {PROJECT_ROOT} at http://localhost:{port}/")
    print(f"Quote proxy: http://localhost:{port}/api/daily-quote")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
