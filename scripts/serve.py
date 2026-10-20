#!/usr/bin/env python3
"""Minimal static server for local use: serves public/ at / and at /dict/."""

import argparse
import functools
import http.server
import os


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def translate_path(self, path):
        if path == "/dict" or path.startswith("/dict/") or path.startswith("/dict?"):
            path = path[len("/dict"):] or "/"
        return super().translate_path(path)

    def do_GET(self):
        if self.path.split("?")[0] == "/dict":
            self.send_response(301)
            self.send_header("Location", "/dict/")
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--dir", default=os.path.join(os.path.dirname(__file__), "..", "public"))
    args = ap.parse_args()
    handler = functools.partial(Handler, directory=os.path.abspath(args.dir))
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print(f"Serving {os.path.abspath(args.dir)} on http://{args.bind}:{args.port}/ (also /dict/)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
