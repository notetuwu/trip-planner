// Google Maps shared lists, read through the undocumented endpoint the list page itself calls
// (no API key; the list must be shared by link). Approach from github.com/ForceGT/gmaps-list-export.
import crypto from "node:crypto";
import type { Place } from "../../shared/types";
import { BROWSER_UA } from "../config";

/** A bare UA makes the maps.app.goo.gl redirector answer with a plain 302 instead of a JS page. */
const SHORTLINK_UA = "Mozilla/5.0";
/** Pre-answered cookie consent, so EU requests are not bounced to consent.google.com. */
const CONSENT_COOKIE: [string, string] = ["SOCS", "CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg"];

async function fetchFollow(url: string, ua: string, jar: Map<string, string>) {
  for (let i = 0; i < 10; i++) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": ua, Cookie: cookie } });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(";"), eq = kv.indexOf("=");
      if (eq > 0) jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).href; continue; }
    return { url, res };
  }
  throw new Error("Too many redirects");
}

export async function fetchGoogleList(shareUrl: string): Promise<{ title: string; places: Place[] }> {
  if (!/^https:\/\/([\w-]+\.)*(google\.[a-z.]+|goo\.gl)\//i.test(shareUrl)) throw new Error("That doesn't look like a Google Maps link.");
  const jar = new Map([CONSENT_COOKIE]);
  let { url: finalUrl } = await fetchFollow(shareUrl, SHORTLINK_UA, jar);
  // If we still landed on the consent page, the real target is in its `continue` parameter.
  const cont = new URL(finalUrl).searchParams.get("continue");
  if (cont) finalUrl = cont;
  const decoded = decodeURIComponent(shareUrl + " " + finalUrl);
  const id = (decoded.match(/\/placelists\/list\/(-?[\w-]+)/) || decoded.match(/!11m\d+!2s(-?[\w-]+)/) || decoded.match(/!2s(-?[\w-]+)/) || [])[1];
  const token = (decoded.match(/[?&]token=([\w-]+)/) || [])[1];
  if (!id) throw new Error("Couldn't find a list in that link. In Google Maps open Saved → your list → Share, and paste that link.");

  const listPage = `https://www.google.com/maps/placelists/list/${id}${token ? `?token=${token}` : ""}`;
  const session = crypto.randomBytes(12).toString("base64url");
  const pb = `!2e2!3e2!4i500!6m3!1s${session}!15i204459!28e2!13s${encodeURIComponent(listPage)}!16b1`;
  const apiUrl = `https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=en&gl=us&pb=${pb}`;
  const { res } = await fetchFollow(apiUrl, BROWSER_UA, jar);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text.replace(/^\)\]\}'\s*/, "")); }
  catch { throw new Error(`Google didn't return the list (HTTP ${res.status}). Make sure it is shared by link and opens in a private window.`); }
  const root = data?.[0];
  if (!root || !Array.isArray(root[8])) throw new Error("The list came back empty. Is it shared by link?");

  // The response is nested arrays; these positions hold the name, note, address, coordinates and place id.
  const places: Place[] = root[8].map((p: any) => {
    const info = p[1] || [];
    const ll = info[5];
    const title = String(p[2] || info[2] || "").trim();
    const placeId = typeof info[7] === "string" ? info[7] : "";
    return {
      title,
      note: typeof p[3] === "string" ? p[3] : "",
      address: typeof info[4] === "string" ? info[4] : "",
      lat: Array.isArray(ll) && typeof ll[2] === "number" ? ll[2] : undefined,
      lng: Array.isArray(ll) && typeof ll[3] === "number" ? ll[3] : undefined,
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(title)}${placeId ? `&query_place_id=${placeId}` : ""}`,
      tags: "", comment: "",
    };
  }).filter((p: Place) => p.title);
  return { title: typeof root[4] === "string" ? root[4] : "", places };
}
