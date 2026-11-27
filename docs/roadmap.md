# Roadmap

What's planned beyond the trip chat (see [chat-roadmap.md](chat-roadmap.md) for that). During a trip the computer
isn't running, so anything meant for the trip itself goes into the phone file (the offline HTML), not the app.

## Next
- [x] **Move stops and days by hand.** A stop's number drags onto another day, its edit window has a Day field, and
      a day's swap button trades it with another day (dates stay). Each with Undo.
- [x] **Paid amounts in the plan.** What was really paid replaces the estimate on a stop and in its day's total, marked.
- [x] **Costs window with expenses and settling up.** Tabs: Overview (estimate, spent and budget per day and kind),
      Plan (estimates changed in place; what was really paid and who paid, also for accommodation and bookings),
      Expenses (any currency, split among some or all, prefilled from a stop of the plan) and Who owes (balances, the
      fewest payments back, each person's share). Synced like the rest of the trip.
- [x] **Expenses on the phone.** The phone file takes expenses during the trip (kept in its browser) and hands them
      back as a small file the app imports (`joinExpenses` in shared/expenses.ts already joins them by id).
- [x] **Today in the phone file.** Opened during the trip: the current and next stop, a directions button, today's
      bookings and the weather saved with the file. Stops can be ticked off on the phone (kept in the browser).
- [x] **GPX / KML export.** "Map file" in the plan's toolbar: the stays, every day's stops and its route, for Organic Maps,
      Garmin, Google My Maps and others.
- [x] **"Not verified" labels in the plan.** On prices from the model and hours from OpenStreetMap (also on the chat
      roadmap).

## Maybe
- [x] **Booking confirmations.** Drop a PDF, an email (.eml) or a screenshot into the chat: it fills in a booking or a
      stay's hotel for you to confirm. Optionally the files are kept in a `docs` folder next to the trip in its save or
      sync folder, linked from the booking.
- [x] **Gmail.** Pick a confirmation straight from your mail ("Add from Gmail" in the chat, a read-only inbox
      browser for one or several accounts): sign-ins with your own Google client, off unless connected.

## Later
- [ ] **Group voting.** Everyone marks saved places as want / fine / skip, and the planner weighs the votes.
- [ ] **Trip journal.** A note per day next to its photos, exported as a page or PDF after the trip (building on
      Preview).
- [ ] **Rain plan.** When the forecast turns bad for a day with outdoor stops, offer to swap it with an indoor day
      (or re-plan it indoors), shown as a change to compare before it happens.
