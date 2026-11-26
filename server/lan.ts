// Phone access: the planner also answers on the home network (Wi-Fi), so a phone can use it. It's the same app and the
// same data (saved trips, place lists, the current trip, the models on this computer), behind a secret link: the
// phone opens the link once (or scans its QR code) and gets a cookie; anything without it is turned away. Keys,
// updates, settings and model downloads stay on this computer only.
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { PORT } from "./config";
import { lanToken } from "./settings";
import type { Req, Res } from "./util/http";

export const LAN_PORT = PORT + 1;
const COOKIE = "tp_lan";
/** What a phone may not do: these stay on the computer itself. */
const BLOCKED = /^\/api\/(keys|update|settings|open|lan|ollama|sync|fs|pick-folder|photos\/delete)(\/|$)/;

let server: http.Server | null = null, since = 0, lastError = "";
let appHandler: ((req: Req, res: Res) => void) | null = null;
/** The app's own request handler, which phone requests go to once they're let in (set when the server starts). */
export const setAppHandler = (h: (req: Req, res: Res) => void) => { appHandler = h; };

/** This computer's addresses on the home network (Wi-Fi or cable), private ranges first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  // Virtual adapters (WSL, Hyper-V, Docker, VirtualBox, VMware, VPNs) aren't reachable from a phone.
  const virtual = /vEthernet|WSL|Hyper-V|docker|VirtualBox|VMware|vboxnet|vmnet|utun|tailscale|zerotier|Loopback/i;
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.") && !virtual.test(name)) out.push(a.address);
  }
  const home = (ip: string) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return [...new Set(out)].sort((a, b) => Number(home(b)) - Number(home(a)));
}

/** This computer's Tailscale address (100.64.0.0/10): reachable from your phone anywhere, once both are on Tailscale. */
export function tailscaleAddresses(): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    const [x, y] = a.address.split(".").map(Number);
    if (a.family === "IPv4" && (/tailscale/i.test(name) || (x === 100 && y >= 64 && y <= 127))) out.push(a.address);
  }
  return [...new Set(out)];
}

/** Whether the Tailscale app is installed here (its usual places), for the steps in Settings → Phone. */
function tailscaleInstalled() {
  const spots = process.platform === "win32" ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe")]
    : process.platform === "darwin" ? ["/Applications/Tailscale.app"] : ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"];
  return spots.some((p) => fs.existsSync(p)) || tailscaleAddresses().length > 0;
}

export function lanStatus() {
  const token = lanToken();
  return {
    running: !!server, port: LAN_PORT, since, error: lastError,
    urls: server ? lanAddresses().map((ip) => `http://${ip}:${LAN_PORT}/?t=${token}`) : [],
    // The same app over Tailscale, for when you're out: its own link (cookies are per address).
    awayUrls: server ? tailscaleAddresses().map((ip) => `http://${ip}:${LAN_PORT}/?t=${token}`) : [],
    tailscale: tailscaleInstalled(),
    platform: process.platform,
  };
}

const cookieOf = (req: Req) => (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

/** Lets a phone in (secret link or cookie), keeps the computer-only parts closed, then hands over to the app. */
export function lanGate(handle: (req: Req, res: Res) => void) {
  return (req: Req, res: Res) => {
    const url = new URL(req.url || "/", "http://x"), token = lanToken();
    if (url.searchParams.get("t") === token) {
      // The link: remember it in a cookie (a year), then show the app without the secret in the address bar.
      url.searchParams.delete("t");
      res.writeHead(302, {
        "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
        Location: url.pathname + (url.search || ""),
      });
      return res.end();
    }
    if (cookieOf(req) !== token) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:24px;max-width:460px">
        <h2>Trip Planner</h2><p>Open the link (or scan the QR code) from <b>Settings → Phone</b> in the planner on your computer.</p></body>`);
    }
    if (BLOCKED.test(url.pathname)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "That's only available on the computer the planner runs on." }));
    }
    (req as Req & { lan?: boolean }).lan = true; // for the API's own checks: a phone, not this computer
    handle(req, res);
  };
}

export function startLan(): Promise<ReturnType<typeof lanStatus>> {
  if (server || !appHandler) return Promise.resolve(lanStatus());
  const handle = appHandler;
  return new Promise((resolve) => {
    const s = http.createServer(lanGate(handle));
    s.once("error", (e: NodeJS.ErrnoException) => {
      lastError = e.code === "EADDRINUSE" ? `Port ${LAN_PORT} is in use by another program.` : e.message;
      server = null;
      resolve(lanStatus());
    });
    s.listen(LAN_PORT, "0.0.0.0", () => {
      server = s; since = Date.now(); lastError = "";
      console.log(`Phone access on the home network: port ${LAN_PORT} (${lanAddresses().join(", ") || "no network found"})`);
      resolve(lanStatus());
    });
  });
}

export function stopLan(): Promise<ReturnType<typeof lanStatus>> {
  const s = server;
  if (!s) return Promise.resolve(lanStatus());
  server = null; since = 0;
  return new Promise((resolve) => { s.close(() => resolve(lanStatus())); s.closeAllConnections(); console.log("Phone access stopped."); });
}
