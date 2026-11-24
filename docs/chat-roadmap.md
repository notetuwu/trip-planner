# Trip chat roadmap

Goal: ask the chat anything about the trip, let it change anything you can change, never let it guess, and always
show what a change does before it happens.

## Principles
- **Accuracy first.** Every figure comes from the plan or a lookup. A lookup that fails means "I couldn't verify
  this" or a question back, never an estimate.
- **Sources always.** Answers list the pages, places and routes they used, with map links you can check yourself.
- **You stay in control.** Changes are previewed; the mode decides what may happen without asking.

## Phase 1: accuracy and control (started)
- [x] Route lookups through several places, using the map's own routing; distances in drafts must be looked up.
- [x] Names tried in other spellings before the fuzzy search (the Hohenzollern bug).
- [x] Sources under each answer: web pages, places (map pin link), routes (directions link with every stop).
- [x] Modes in a drop-up menu in the chat toolbar (icon, name, what it does; Shift+Tab cycles): **Ask** (read-only),
      **Manual** (every change needs Apply), **Auto** (small edits that don't re-plan apply by themselves with Undo;
      anything else asks).
- [x] Change cards with a short headline, day chips, the edits as a list, and the planner instruction folded away.
- [x] Stricter figure check: every distance and driving time in an answer or change must match the trip or a lookup
      result (rounding and the total of two legs allowed). Otherwise the chat is sent back once to look it up; what
      still isn't backed up is marked "Not verified" in the answer and for the planner.
- [x] The chat sees the routed drives between stays (as the map has them), so it needn't guess those.
- [x] The chat is told to call hours, prices and timetables it didn't look up unverified.
- [ ] Labels in the plan itself on what can't be verified from here (ticket prices from the model, hours from
      OpenStreetMap).

## Phase 2: see the whole trip
- [x] `LOOKUP: trip | topic` into what the page knows beyond the trip text: `costs` (per day, against the budget),
      `fuel`, `checks` (stops in the wrong place or closed at their time, repeated restaurants, long drive days, days
      over budget), `weather`, `places` (all saved places with must / skip), `bookings`, `packing`.
- [ ] Shrink the trip text itself to an overview, with `day N` in full on demand (only worth it for very long trips).

## Phase 3: change anything
- [x] Flat `edits` the page makes itself, without the planner: travelers, budget, currency, pace, fitness, day start,
      breakfast, interests, wishes; stays (nights, hotel, travel mode, add, remove; dates re-chained); moving a stop to
      another day, swapping two days, a stop's cost; bookings (add, remove), ticking off "Book ahead"; must-see and
      skip; the car; notes and ideas. Bad edits are dropped on the server.
- [x] **Recalculate costs** without the planner (`rescaleCosts`), per person or per group from the planner's new
      `costPer` field, else inferred by kind. New plans remember their traveler count; the chat offers it when that
      differs.
- [x] A request that is only about costs or numbers never goes to the planner (prompt rule).
- [x] The "Book ahead" checklist and the packing list: the chat sees both with their ticks, ticks and unticks
      entries, and adds or removes your own packing items.
- [ ] Ticking place lists from the chat.
- [ ] One cheap model call for old items the rules can't place as per person or per group.

## Phase 4: preview and compare
- [x] **Compare modal**, side by side like a git diff, with Apply / Not now (or Keep / Put back) inside:
  - Plan: the changed days as two timelines; added green, removed red and struck through, retimed or re-priced marked.
  - Costs: before and after per day, changes highlighted, totals and budget.
  - Map: two maps (before grey, after blue) with linked pan and zoom; added stops green, removed red.
  - Setup: old → new for every field, the stays, must-sees and skips, bookings, the car.
  - Tabs only for what changed; stacked on phones.
- [x] **Review** on cards the page makes itself (nothing happens until Apply); **Try it & compare** for planner
      changes (made, compared, then kept or put back).
- [x] Impact line on the card and in the modal: the plan's total, days over budget, nights.
- [ ] Inline (single column) toggle in the plan tab; drive km and time per leg on the maps; warnings (after sunset,
      closed that day) in the impact line.

## Phase 5: extras
- [x] What-if questions: answered with what it would mean, then offered as a change to compare (prompt rule).
- [x] "Check my plan" (first suggestion, and a quick reply), using the `checks`, `costs` and `fuel` lookups.
- [x] The plan's stops named in answers are clickable: the map flies to them.
- [ ] ~~Quick replies under the last answer~~ (tried, removed: too noisy).
- [x] Lasting preferences remembered into the trip's notes (the `note` edit, offered by the chat).
- [x] Several changes in one card with a checklist: untick parts to leave them out (the impact updates).
