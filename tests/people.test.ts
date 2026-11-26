// Who does each stop, by name: splits and meet-ups follow from it.
import { describe, expect, it } from "vitest";
import { byTime, cleanNames, company, sections } from "../shared/people";

const names = ["Me", "Anna", "Ben", "Cara"];
const stop = (time: string, place: string, ...who: string[]) => ({ time, place, who });

describe("who does a stop", () => {
  it("cleans names and puts a company in the travelers' order", () => {
    expect(cleanNames("Me, Anna ,anna; Ben + Cara")).toEqual(["Me", "Anna", "Ben Cara"]);
    expect(company(["cara", "Me"], names, 4)).toEqual(["Me", "Cara"]);
  });
  it("is everyone when all go, or nobody's said", () => {
    expect(company(["Ben", "Me", "Cara", "Anna"], names, 4)).toEqual([]);
    expect(company(undefined, names, 4)).toEqual([]);
    expect(company(["Me", "Anna"], ["Me", "Anna"], 4)).toEqual(["Me", "Anna"]); // two of four, even unnamed
  });
});

describe("a day with splits and a meet-up", () => {
  const day = byTime([
    stop("09:00", "Rest at the hotel", "Ben"),
    stop("09:00", "Side quest", "Cara"),
    stop("12:03", "Ueno Zoo", "Me", "Anna"),
    stop("18:39", "Back to hotel", "Me"),
    stop("17:19", "Robot Cafe", "Me", "Anna", "Ben"),
    stop("19:00", "Boardgame cafe", "Anna", "Ben"),
    stop("22:00", "Back to hotel", "Anna", "Ben"),
  ]);
  const got = sections(day, (x) => company(x.who, names, 4)).map((s) => "item" in s ? day[s.item].place
    : { cols: s.fork.cols.map((c) => `${c.who.join("+")}: ${c.items.map((i) => day[i].place).join(", ")}`), meanwhile: s.fork.meanwhile.map((m) => `${m.who.join("+")}: ${day[m.item].place}`) });

  it("reads in time order: apart, together at the cafe, apart again", () => {
    expect(got).toEqual([
      { cols: ["Ben: Rest at the hotel", "Cara: Side quest", "Me+Anna: Ueno Zoo"], meanwhile: [] },
      { cols: ["Me+Anna+Ben: Robot Cafe"], meanwhile: ["Cara: Side quest"] },
      { cols: ["Me: Back to hotel", "Anna+Ben: Boardgame cafe, Back to hotel"], meanwhile: ["Cara: Side quest"] },
    ]);
  });
  it("starts afresh after a stop everyone does", () => {
    const d = [stop("09:00", "A", "Me"), stop("12:00", "Lunch"), stop("14:00", "B", "Anna")];
    const s = sections(d, (x) => company(x.who, names, 4));
    expect(s.map((x) => "item" in x ? "all" : x.fork.meanwhile.length)).toEqual([0, "all", 0]);
  });
});
