// CSV parsing for place lists: Google Takeout "Saved" exports and simple name/lat/lng sheets.
import type { Place } from "../../shared/types";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Accepts Google Takeout CSVs (Title, Note, URL, Tags, Comment) and sheets with name/lat/lng columns. */
export function csvToPlaces(text: string): Place[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const c = {
    title: col("title", "name"), note: col("note", "notes", "description"), url: col("url", "link"),
    tags: col("tags"), comment: col("comment"), address: col("address"),
    lat: col("lat", "latitude"), lng: col("lng", "lon", "long", "longitude"),
  };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] || "").trim() : "");
  const num = (v: string) => (v === "" || isNaN(+v) ? undefined : +v);
  return rows
    .map((r) => ({
      title: get(r, c.title), note: get(r, c.note), url: get(r, c.url), tags: get(r, c.tags),
      comment: get(r, c.comment), address: get(r, c.address), lat: num(get(r, c.lat)), lng: num(get(r, c.lng)),
    }))
    .filter((p) => p.title);
}
