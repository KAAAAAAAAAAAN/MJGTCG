import { describe, it, expect } from "vitest";
import { ManualSession } from "./manual.js";

const mk = () => ManualSession.create({ seats: [0, 1], main: ["A", "B", "C", "D", "E", "F", "G"], faith: ["X", "Y"], startingHand: 2, rng: () => 0 });

describe("ManualSession (free-form sandbox)", () => {
  it("deals shared decks + per-seat opening hands", () => {
    const s = mk();
    expect(s.state.players[0]!.hand.length).toBe(2);
    expect(s.state.players[1]!.hand.length).toBe(2);
    expect(s.state.mainDeck.length).toBe(7 - 4); // 7 main minus 2 hands of 2
    expect(s.state.faithDeck.length).toBe(2);
  });

  it("move: hand -> board with a field position, and the universal move detaches from any zone", () => {
    const s = mk();
    const iid = s.state.players[0]!.hand[0]!;
    expect(s.apply(0, { do: "move", iid, to: { zone: "board", player: 0, x: 120, y: 40 } }).ok).toBe(true);
    expect(s.state.players[0]!.board).toContain(iid);
    expect(s.state.players[0]!.hand).not.toContain(iid);
    expect(s.state.cards[iid]!.x).toBe(120);
    // move it again -> banish
    expect(s.apply(1, { do: "move", iid, to: { zone: "banish" } }).ok).toBe(true);
    expect(s.state.banish).toContain(iid);
    expect(s.state.players[0]!.board).not.toContain(iid);
  });

  it("tap / flip / target / counter toggle and accumulate", () => {
    const s = mk();
    const iid = s.state.players[0]!.hand[0]!;
    s.apply(0, { do: "tap", iid });
    expect(s.state.cards[iid]!.tapped).toBe(true);
    s.apply(0, { do: "flip", iid });
    expect(s.state.cards[iid]!.faceDown).toBe(true);
    s.apply(0, { do: "target", iid });
    expect(s.state.cards[iid]!.targeted).toBe(true);
    s.apply(0, { do: "counter", iid, name: "code", delta: 2 });
    expect(s.state.cards[iid]!.counters["code"]).toBe(2);
    s.apply(0, { do: "counter", iid, name: "code", delta: -2 });
    expect(s.state.cards[iid]!.counters["code"]).toBeUndefined();
  });

  it("overlay tucks a card beneath another and lifts it out of its zone", () => {
    const s = mk();
    const [a, b] = s.state.players[0]!.hand;
    s.apply(0, { do: "move", iid: a!, to: { zone: "board", player: 0 } });
    s.apply(0, { do: "move", iid: b!, to: { zone: "board", player: 0 } });
    s.apply(0, { do: "overlay", iid: b!, onto: a! });
    expect(s.state.cards[a!]!.overlays).toContain(b!);
    expect(s.state.players[0]!.board).not.toContain(b!); // tucked, not a standalone board card
    expect(s.state.players[0]!.board).toContain(a!);
  });

  it("draw moves the top of a deck to a player's hand", () => {
    const s = mk();
    const top = s.state.mainDeck[0]!;
    s.apply(0, { do: "draw", player: 1, zone: "mainDeck", n: 1 });
    expect(s.state.players[1]!.hand).toContain(top);
    expect(s.state.mainDeck).not.toContain(top);
  });

  it("peek reveals a pile to the searcher only; reorder permutes it", () => {
    const s = mk();
    s.apply(0, { do: "peek", zone: "mainDeck" });
    expect(s.viewFor(0).peek?.zone).toBe("mainDeck");
    expect(s.viewFor(0).peek!.cards.length).toBe(s.state.mainDeck.length);
    expect(s.viewFor(1).peek).toBeNull(); // not revealed to the other player
    const rev = [...s.state.mainDeck].reverse();
    expect(s.apply(0, { do: "reorder", zone: "mainDeck", order: rev }).ok).toBe(true);
    expect(s.state.mainDeck).toEqual(rev);
    expect(s.apply(0, { do: "reorder", zone: "mainDeck", order: ["nope"] }).ok).toBe(false); // not a permutation
  });

  it("redaction: own hand revealed, opponents' hidden; decks hidden; face-down board hidden to others", () => {
    const s = mk();
    const v0 = s.viewFor(0);
    expect(v0.players[0]!.hand!.every((c) => c.cardId !== null)).toBe(true); // own hand revealed
    expect(v0.players[1]!.hand).toBeNull(); // opponent hand hidden
    expect(v0.players[1]!.handCount).toBe(2); // but count is known
    expect(v0.mainDeckCount).toBe(s.state.mainDeck.length);
    // a face-down board card: revealed to its controller, hidden from others
    const iid = s.state.players[0]!.hand[0]!;
    s.apply(0, { do: "move", iid, to: { zone: "board", player: 0 } });
    s.apply(0, { do: "flip", iid });
    expect(s.viewFor(0).players[0]!.board.find((c) => c.iid === iid)!.cardId).not.toBeNull(); // controller sees it
    expect(s.viewFor(1).players[0]!.board.find((c) => c.iid === iid)!.cardId).toBeNull(); // opponent doesn't
  });

  it("move to hand with a numeric pos inserts at that index (drag-to-reorder)", () => {
    const s = mk(); // opening hand of 2
    const [a, b] = s.state.players[0]!.hand;
    expect(s.apply(0, { do: "move", iid: b!, to: { zone: "hand", player: 0, pos: 0 } }).ok).toBe(true);
    expect(s.state.players[0]!.hand).toEqual([b, a]); // b lifted to the front
  });

  it("reorder accepts a PREFIX permutation (reorder the top N, keep the rest)", () => {
    const s = mk();
    const deck = [...s.state.mainDeck]; // 3 cards after dealing
    const [d0, d1] = deck;
    expect(s.apply(0, { do: "reorder", zone: "mainDeck", order: [d1!, d0!] }).ok).toBe(true); // swap top 2
    expect(s.state.mainDeck).toEqual([d1, d0, deck[2]]);
    expect(s.apply(0, { do: "reorder", zone: "mainDeck", order: ["nope", d0!] }).ok).toBe(false); // unknown iid
  });
});
