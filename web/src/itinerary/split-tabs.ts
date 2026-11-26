// A split day's groups side by side while each has room; in a narrow column (a phone, the chat open, three groups or
// more) the groups become tabs, one at full width. A group with a stop or two gets a slim column of its own, so the busy
// group has the width. Which tab is open stays across redraws.

/** Width a group needs side by side: a slim one (a stop or two), and the rest. */
const SLIM = 190, WIDE = 300, GAP = 10;
/** The tab open in each split, by "<day>-<split>" (and "/<group>" for a split inside a group). */
const open = new Map<string, string>();

let observer: ResizeObserver | null = null;

/** Side by side or as tabs, by how wide the split is now. */
function fit(split: HTMLElement) {
  const tracks = [...split.querySelectorAll<HTMLElement>(":scope > .tracks > .track")];
  const need = tracks.reduce((n, t) => n + (t.classList.contains("slim") ? SLIM : WIDE), 0) + GAP * (tracks.length - 1);
  const tabbed = tracks.length > 1 && split.clientWidth < need;
  split.classList.toggle("tabbed", tabbed);
  if (tabbed) show(split, open.get(split.dataset.split!) || split.dataset.main!);
}

/** Opens one group's tab. */
function show(split: HTMLElement, group: string) {
  const tracks = [...split.querySelectorAll<HTMLElement>(":scope > .tracks > .track")];
  if (!tracks.some((t) => t.dataset.g === group)) group = tracks[0]?.dataset.g || "";
  for (const t of tracks) t.classList.toggle("on", t.dataset.g === group);
  for (const b of split.querySelectorAll<HTMLButtonElement>(":scope > .split-tabs > [data-split-tab]")) {
    const on = b.dataset.splitTab === group;
    b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on));
  }
}

/** Sets up the splits just drawn into `root`. */
export function initSplitTabs(root: HTMLElement) {
  observer?.disconnect();
  observer = new ResizeObserver((entries) => { for (const e of entries) fit(e.target as HTMLElement); });
  for (const split of root.querySelectorAll<HTMLElement>(".split")) {
    observer.observe(split);
    fit(split);
    split.querySelector(":scope > .split-tabs")?.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-split-tab]");
      if (!b) return;
      open.set(split.dataset.split!, b.dataset.splitTab!);
      show(split, b.dataset.splitTab!);
    });
  }
}

/** A stop in a group whose tab isn't open (clicked on the map, say): its tabs open, so it can be shown. */
export function revealInSplit(el: Element) {
  for (let track = el.closest<HTMLElement>(".track"); track; track = track.parentElement?.closest<HTMLElement>(".track") || null) {
    const split = track.parentElement?.closest<HTMLElement>(".split");
    if (!split?.classList.contains("tabbed") || track.classList.contains("on")) continue;
    open.set(split.dataset.split!, track.dataset.g!);
    show(split, track.dataset.g!);
  }
}
