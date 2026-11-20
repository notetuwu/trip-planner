#!/usr/bin/env python3
"""Start the trip planner: runs `node server.js` (unless it is already running) and opens it in the browser.

Usage:  python start.py [--port 5173] [--no-browser]
Stop with Ctrl+C (or close the window).
"""
import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))


def is_up(url):
    try:
        with urllib.request.urlopen(url + "/api/lists", timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5173)))
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    args = ap.parse_args()
    url = f"http://localhost:{args.port}"

    if is_up(url):
        print(f"Trip planner is already running at {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return

    node = shutil.which("node")
    if not node:
        sys.exit("Node.js is needed but wasn't found on PATH. Install it from https://nodejs.org and try again.")

    proc = subprocess.Popen([node, os.path.join(HERE, "server.js")], cwd=HERE, env={**os.environ, "PORT": str(args.port)})
    for _ in range(150):
        if proc.poll() is not None:
            sys.exit(f"The server stopped (exit code {proc.returncode}). Is port {args.port} already in use? Try --port 5174.")
        if is_up(url):
            break
        time.sleep(0.1)
    else:
        print("The server is taking a while to respond; opening the browser anyway.")

    if not args.no_browser:
        webbrowser.open(url)
    print("Press Ctrl+C to stop.")
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        proc.wait()


if __name__ == "__main__":
    main()
