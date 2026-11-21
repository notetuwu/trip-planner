#!/usr/bin/env python3
"""Start the trip planner and open it in the browser.

Installs the dependencies and builds the app the first time (and again whenever the source changed), then runs
the server unless it's already running.

Usage:  python start.py [--port 5173] [--no-browser] [--dev]
  --dev   run the Vite dev server instead (hot reload while editing the code)
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
BUILT = os.path.join(HERE, "dist", "server", "main.js")
SOURCES = ["web", "server", "shared", "index.html", "package.json", "vite.config.ts"]


def is_up(url):
    try:
        with urllib.request.urlopen(url + "/api/lists", timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


def newest_source():
    newest = 0.0
    for name in SOURCES:
        path = os.path.join(HERE, name)
        if os.path.isfile(path):
            newest = max(newest, os.path.getmtime(path))
        for root, _, files in os.walk(path):
            for f in files:
                newest = max(newest, os.path.getmtime(os.path.join(root, f)))
    return newest


def npm(npm_cmd, *args):
    result = subprocess.run([npm_cmd, *args], cwd=HERE)
    if result.returncode != 0:
        sys.exit(f"`npm {' '.join(args)}` failed (exit code {result.returncode}).")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5173)))
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    ap.add_argument("--dev", action="store_true", help="run the Vite dev server (hot reload)")
    args = ap.parse_args()
    url = f"http://localhost:{args.port}"

    if is_up(url):
        print(f"Trip planner is already running at {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return

    node, npm_cmd = shutil.which("node"), shutil.which("npm")
    if not node or not npm_cmd:
        sys.exit("Node.js (with npm) is needed but wasn't found on PATH. Install it from https://nodejs.org and try again.")

    if not os.path.isdir(os.path.join(HERE, "node_modules")):
        print("Installing dependencies (first run)...")
        npm(npm_cmd, "install")

    env = {**os.environ, "PORT": str(args.port)}
    if args.dev:
        cmd = [npm_cmd, "run", "dev"]
    else:
        if not os.path.exists(BUILT) or newest_source() > os.path.getmtime(BUILT):
            print("Building the app...")
            npm(npm_cmd, "run", "build")
        cmd = [node, BUILT]

    proc = subprocess.Popen(cmd, cwd=HERE, env=env)
    for _ in range(300):
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
