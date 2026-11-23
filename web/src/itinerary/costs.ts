// The cost breakdown window: the total against the budget, per person, by kind (sights, meals, transport), per day
// with its stops, bookings (also ones already paid), the most expensive stops, and a CSV download.
import { $, downloadFile, esc } from "../core/dom";
import { fmtDate, fmtTime, money } from "../core/format";
import { groupBudget, state } from "../core/state";
import { splitGroup } from "../trip/modes";

const KINDS: [string, string][] = [["sight", "Sights"], ["activity", "Activities"], ["meal", "Meals"], ["transfer", "Getting around"], ["other", "Other"]];

function bodyHtml() {
  const it = state.itinerary!, cur = state.currency, n = Math.max(1, Number(state.travelers) || 1);
  const items = it.days.flatMap((d, di) => d.items.map((x) => ({ ...x, date: d.date, di, cost: Number(x.cost) || 0 })));
  const total = it.days.reduce((s, d) => s + (Number(d.estimatedCost) || 0), 0);
  const perDay = groupBudget(), budget = perDay * it.days.length, diff = budget - total;
  const paid = (state.bookings || []).filter((b) => b.name && b.cost && !b.countCost);
  const paidSum = paid.reduce((s, b) => s + (b.cost || 0), 0);
  const byKind = KINDS.map(([k, label]) => [label, items.filter((x) => (x.kind || "other") === k || (k === "other" && !KINDS.some(([kk]) => kk === x.kind))).reduce((s, x) => s + x.cost, 0)] as const).filter(([, v]) => v > 0);
  const top = [...items].filter((x) => x.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, 6);
  const bar = (v: number, max: number) => `<span class="cb-bar"><i style="width:${max ? Math.max(2, (v / max) * 100) : 0}%"></i></span>`;
  const maxDay = Math.max(1, ...it.days.map((d) => Number(d.estimatedCost) || 0));
  return `
    <div class="stats cb-stats">
      <div class="stat"><b>${money(total, cur)}</b><span>estimated total</span></div>
      ${n > 1 ? `<div class="stat"><b>${money(total / n, cur)}</b><span>per person (${n} travelers)</span></div>` : ""}
      ${perDay ? `<div class="stat ${diff < 0 ? "over" : ""}"><b>${money(Math.abs(diff), cur)}</b><span>${diff < 0 ? "over" : "under"} the budget of ${money(budget, cur)} (${money(perDay, cur)} a day)</span></div>` : ""}
      ${paidSum ? `<div class="stat"><b>${money(paidSum, cur)}</b><span>already paid (not in the total)</span></div>` : ""}
    </div>
    <h3>By kind</h3>
    <table class="cb-table">${byKind.map(([label, v]) => `<tr><td>${label}</td><td>${bar(v, total)}</td><td class="num">${money(v, cur)}</td><td class="num muted">${total ? Math.round((v / total) * 100) : 0}%</td></tr>`).join("")}</table>
    ${(state.bookings || []).some((b) => b.name && b.cost != null) ? `<h3>Bookings</h3>
    <table class="cb-table">${(state.bookings || []).filter((b) => b.name && b.cost != null).map((b) => `<tr><td>${esc(b.name)}</td><td class="muted">${esc(fmtDate(b.date))}${b.from ? ` ${esc(fmtTime(b.from))}` : ""}</td><td class="num">${money(b.cost, cur)}</td><td class="muted">${b.countCost ? "in the day's cost" : "already paid"}</td></tr>`).join("")}</table>` : ""}
    <h3>Per day</h3>
    ${it.days.map((d, di) => {
      const cost = Number(d.estimatedCost) || 0, paidItems = d.items.filter((x) => Number(x.cost) > 0);
      return `<details class="cb-day"><summary><span class="cb-date">${esc(fmtDate(d.date))}</span><span class="cb-city">${esc(d.city)}</span>${bar(cost, maxDay)}<span class="num${perDay && cost > perDay ? " over" : ""}">${money(cost, cur)}</span></summary>
        ${paidItems.length ? `<table class="cb-table">${paidItems.map((x) => `<tr><td class="muted">${esc(fmtTime(x.time))}</td><td>${esc(x.place)}${splitGroup(x) ? ` <span class="muted">· ${esc(x.group)}</span>` : ""}</td><td class="num">${money(Number(x.cost), cur)}</td></tr>`).join("")}</table>` : `<p class="hint">Nothing paid that day.</p>`}
      </details>`; }).join("")}
    ${top.length ? `<h3>Most expensive</h3>
    <table class="cb-table">${top.map((x) => `<tr><td>${esc(x.place)}</td><td class="muted">${esc(fmtDate(x.date))}</td><td class="num">${money(x.cost, cur)}</td></tr>`).join("")}</table>` : ""}
    <p class="hint">Costs are the planner's estimates for the whole group${it.localCurrency && it.localCurrency !== cur ? `, in ${esc(cur)} (prices there are in ${esc(it.localCurrency)})` : ""}. Hotels aren't included.</p>
    <button class="btn" type="button" data-cb-csv>Download as CSV</button>`;
}

/** Every stop with a cost, for a spreadsheet. */
function csv() {
  const it = state.itinerary!, q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = it.days.flatMap((d) => d.items.map((x) => [d.date, x.time, x.place, x.kind || "", splitGroup(x) || "", Number(x.cost) || 0]));
  return [["date", "time", "place", "kind", "group", `cost (${state.currency})`], ...rows].map((r) => r.map(q).join(",")).join("\n");
}

export function openCosts() {
  if (!state.itinerary) return;
  const dlg = $<HTMLDialogElement>("#costsDialog");
  const it = state.itinerary;
  $("#costsMeta").textContent = `${it.days.length} days · ${state.travelers} traveler${state.travelers > 1 ? "s" : ""} · estimates for the whole group`;
  $("#costsBody").innerHTML = bodyHtml();
  $("#costsBody").querySelector<HTMLButtonElement>("[data-cb-csv]")!.onclick = () => downloadFile(new Blob([csv()], { type: "text/csv" }), "trip-costs.csv");
  if (!dlg.open) dlg.showModal();
}
