import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./reducer.js";
import * as E from "./effects.js";

function freshGame() {
  // single player, 10-card opaque main deck, 3-card starting hand -> mainDeck=7
  return M.newGame({ players: [0], mainDeck: 10, startingHand: 3 });
}

const baseSet = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../base_set.json"), "utf-8"));
/** A single-player game whose opening hand is exactly `cards` (drawn from the deck top),
 *  with a real card registry so isBrick / stats resolve. */
function gameWithHand(cards: string[]) {
  const deck = [...cards, ...Array<string>(10).fill("MJG-011")];
  return M.newGame({ players: [0], mainDeck: deck, startingHand: cards.length, cardRegistry: baseSet });
}

describe("intent primitives", () => {
  it("draw: pulls N from the top of the Main deck into hand", () => {
    const s = freshGame();
    const expected = s.mainDeck.slice(0, 2);
    const r = E.applyIntent(s, { kind: "draw", player: 0, count: 2 });
    expect(r.result).toEqual(expected);
    expect(M.player(r.state, 0).hand.length).toBe(5);
    expect(r.state.mainDeck.length).toBe(5);
  });

  it("draw from faith deck", () => {
    let s = M.newGame({ players: [0], mainDeck: 5, faithDeck: 3, startingHand: 2 });
    const top = s.faithDeck[0];
    const r = E.applyIntent(s, { kind: "draw", player: 0, count: 1, deck: "faith" });
    expect(r.result).toEqual([top]);
    expect(M.player(r.state, 0).hand).toContain(top);
    expect(r.state.faithDeck.length).toBe(2);
  });

  it("summonTopOfDeck: moves the top card to the controller's board, returns its iid", () => {
    const s = freshGame();
    const top = s.mainDeck[0]!;
    const r = E.applyIntent(s, { kind: "summonTopOfDeck", controller: 0 });
    expect(r.result).toBe(top);
    expect(M.player(r.state, 0).board).toContain(top);
    expect(r.state.mainDeck[0]).not.toBe(top);
    expect(M.inst(r.state, top).tapped).toBe(false);
  });

  it("specialSummon: moves a hand card to the board face-up & untapped", () => {
    const s = freshGame();
    const h = M.player(s, 0).hand[0]!;
    const r = E.applyIntent(s, { kind: "specialSummon", iid: h, controller: 0 });
    expect(M.player(r.state, 0).board).toContain(h);
    expect(M.player(r.state, 0).hand).not.toContain(h);
    expect(M.inst(r.state, h).faceDown).toBe(false);
    expect(M.inst(r.state, h).tapped).toBe(false);
  });

  it("discard: moves a card to the top of the discard pile", () => {
    const s = freshGame();
    const h = M.player(s, 0).hand[0]!;
    const r = E.applyIntent(s, { kind: "discard", iid: h });
    expect(r.state.discard[0]).toBe(h);
    expect(M.player(r.state, 0).hand).not.toContain(h);
  });

  describe("moveTo", () => {
    // put a card on the board first (special summon a hand card)
    function onBoard() {
      const s0 = freshGame();
      const c = M.player(s0, 0).hand[0]!;
      const s = E.applyIntent(s0, { kind: "specialSummon", iid: c, controller: 0 }).state;
      return { s, c };
    }
    it("to hand: returns a board card to its owner's hand", () => {
      const { s, c } = onBoard();
      const r = E.applyIntent(s, { kind: "moveTo", iid: c, to: "hand" }).state;
      expect(M.player(r, 0).hand).toContain(c);
      expect(M.player(r, 0).board).not.toContain(c);
    });
    it("to banish", () => {
      const { s, c } = onBoard();
      const r = E.applyIntent(s, { kind: "moveTo", iid: c, to: "banish" }).state;
      expect(r.banish[0]).toBe(c);
    });
    it("to deckTop / deckBottom", () => {
      const { s, c } = onBoard();
      expect(E.applyIntent(s, { kind: "moveTo", iid: c, to: "deckTop" }).state.mainDeck[0]).toBe(c);
      const bot = E.applyIntent(s, { kind: "moveTo", iid: c, to: "deckBottom" }).state.mainDeck;
      expect(bot[bot.length - 1]).toBe(c);
    });
    it("to discardBottom", () => {
      const { s, c } = onBoard();
      const d = E.applyIntent(s, { kind: "moveTo", iid: c, to: "discardBottom" }).state.discard;
      expect(d[d.length - 1]).toBe(c);
    });
  });
});

describe("interpreter (runEffect) — real card scripts", () => {
  // MJG-001 "Nyagger" top: "You can Special Summon this card, then draw 1 card."
  const nyaggerTop: E.EffectScript = function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
    yield { kind: "draw", player: ctx.controller, count: 1 };
  };

  it("Nyagger top: special-summons self, then draws 1", () => {
    const s = freshGame();
    const self = M.player(s, 0).hand[0]!;
    const h0 = M.player(s, 0).hand.length;
    const deck0 = s.mainDeck.length;
    const out = E.runEffect(s, nyaggerTop, { controller: 0, self });
    expect(M.player(out, 0).board).toContain(self);
    expect(M.player(out, 0).hand).not.toContain(self);
    expect(M.player(out, 0).hand.length).toBe(h0); // -1 (summon) +1 (draw)
    expect(out.mainDeck.length).toBe(deck0 - 1);
  });

  // MJG-001 bottom "What's Yaku?": "Special Summon the top card of the deck."
  // Exercises the intent-result channel (.next() feeds the summoned iid back).
  const summonTop: E.EffectScript = function* (ctx) {
    const iid = (yield { kind: "summonTopOfDeck", controller: ctx.controller }) as string | null;
    if (iid !== null) yield { kind: "draw", player: ctx.controller, count: 1 };
  };

  it("summon-top: result threads back into the script", () => {
    const s = freshGame();
    const top = s.mainDeck[0]!;
    const deck0 = s.mainDeck.length;
    const out = E.runEffect(s, summonTop, { controller: 0, self: top });
    expect(M.player(out, 0).board).toContain(top);
    expect(out.mainDeck.length).toBe(deck0 - 2); // 1 summoned + 1 drawn
  });
});

describe("Pizza Hut C.C. (MJG-CC) — discard/banish becomes a Code counter", () => {
  function pizzaOnBoard(over: Partial<M.CardInstance> = {}) {
    const s0 = freshGame();
    const c = M.player(s0, 0).hand[0]!;
    let s = E.applyIntent(s0, { kind: "specialSummon", iid: c, controller: 0 }).state;
    s = M.replace(s, { instances: { ...s.instances, [c]: { ...M.inst(s, c), cardId: "MJG-CC", counters: { code: 1 }, ...over } } });
    return { s, c };
  }
  it("a face-up Pizza Hut that would be banished gains a Code counter instead and stays in play", () => {
    const { s, c } = pizzaOnBoard();
    const r = E.applyIntent(s, { kind: "moveTo", iid: c, to: "banish" }).state;
    expect(M.player(r, 0).board).toContain(c);
    expect(r.banish).not.toContain(c);
    expect(M.inst(r, c).counters["code"]).toBe(2); // 1 -> 2
  });
  it("a face-up Pizza Hut that would be discarded gains a Code counter instead", () => {
    const { s, c } = pizzaOnBoard();
    const r = E.applyIntent(s, { kind: "discard", iid: c }).state;
    expect(M.player(r, 0).board).toContain(c);
    expect(r.discard).not.toContain(c);
    expect(M.inst(r, c).counters["code"]).toBe(2);
  });
  it("with its effects negated the replacement is suppressed (banished normally)", () => {
    const { s, c } = pizzaOnBoard({ effectsNegated: true });
    const r = E.applyIntent(s, { kind: "moveTo", iid: c, to: "banish" }).state;
    expect(r.banish).toContain(c);
    expect(M.player(r, 0).board).not.toContain(c);
  });
});

describe("Spinzaku LIVE! (MJG-C21) — discard/banish becomes an overlay", () => {
  function spinAnd(host: boolean, over: Partial<M.CardInstance> = {}) {
    const s0 = freshGame();
    const hand = M.player(s0, 0).hand;
    const spin = hand[0]!;
    let s = E.applyIntent(s0, { kind: "specialSummon", iid: spin, controller: 0 }).state;
    let hostId: string | undefined;
    if (host) { hostId = hand[1]!; s = E.applyIntent(s, { kind: "specialSummon", iid: hostId, controller: 0 }).state; }
    s = M.replace(s, { instances: { ...s.instances, [spin]: { ...M.inst(s, spin), cardId: "MJG-C21", ...over } } });
    return { s, spin, hostId };
  }
  it("a face-up Spinzaku that would be banished COVERS another character instead", () => {
    const { s, spin, hostId } = spinAnd(true);
    const r = E.applyIntent(s, { kind: "moveTo", iid: spin, to: "banish" }).state;
    expect(r.banish).not.toContain(spin);
    expect(M.player(r, 0).board).toContain(spin); // Spinzaku takes the host's slot (stack top)
    expect(M.player(r, 0).board).not.toContain(hostId!); // the host is covered
    expect(M.inst(r, spin).overlays).toContain(hostId!); // tucked beneath Spinzaku
  });
  it("with no other character, Spinzaku is shuffled into the Faith Deck instead", () => {
    const { s, spin } = spinAnd(false);
    const r = E.applyIntent(s, { kind: "discard", iid: spin }).state;
    expect(M.player(r, 0).board).not.toContain(spin);
    expect(r.discard).not.toContain(spin);
    expect(r.faithDeck).toContain(spin);
  });
  it("with its effects negated the replacement is suppressed (banished normally)", () => {
    const { s, spin } = spinAnd(true, { effectsNegated: true });
    const r = E.applyIntent(s, { kind: "moveTo", iid: spin, to: "banish" }).state;
    expect(r.banish).toContain(spin);
  });
});

describe("attachOverlay: an overlaid stack is FLAT (overlaying onto a stack lifts them all)", () => {
  it("overlaying a card that already has overlays lifts them all up to the host", () => {
    let s = freshGame(); // 1 player, hand of 3
    const [host, card, sub] = M.player(s, 0).hand;
    s = E.applyIntent(s, { kind: "specialSummon", iid: host!, controller: 0 }).state;
    s = E.applyIntent(s, { kind: "specialSummon", iid: card!, controller: 0 }).state;
    s = E.applyIntent(s, { kind: "attachOverlay", host: card!, card: sub!, from: "hand" }).state; // sub tucks under card
    expect(M.inst(s, card!).overlays).toEqual([sub]);
    // overlay `card` (which already carries [sub]) onto `host`
    s = E.applyIntent(s, { kind: "attachOverlay", host: host!, card: card!, from: "board" }).state;
    expect(M.inst(s, host!).overlays).toEqual([card, sub]); // flattened: card AND its former overlay
    expect(M.inst(s, card!).overlays).toEqual([]); // no nested stack-within-a-stack
  });

  it("overlaySummon carries the target's materials up (Zeus onto Dante gets all of them)", () => {
    let s = M.newGame({ players: [0], mainDeck: 10, startingHand: 4 });
    const [zeus, dante, m1, m2] = M.player(s, 0).hand;
    s = E.applyIntent(s, { kind: "specialSummon", iid: dante!, controller: 0 }).state;
    s = E.applyIntent(s, { kind: "attachOverlay", host: dante!, card: m1!, from: "hand" }).state;
    s = E.applyIntent(s, { kind: "attachOverlay", host: dante!, card: m2!, from: "hand" }).state;
    expect(M.inst(s, dante!).overlays).toEqual([m1, m2]); // Dante has 2 materials
    // summon Zeus by overlaying it onto Dante
    s = E.applyIntent(s, { kind: "overlaySummon", iid: zeus!, onto: dante! }).state;
    expect(M.player(s, 0).board).toContain(zeus);
    expect(M.player(s, 0).board).not.toContain(dante);
    expect(M.inst(s, zeus!).overlays).toEqual([dante, m1, m2]); // Dante + its 2 materials
    expect(M.inst(s, dante!).overlays).toEqual([]); // not nested under Dante
  });
});

describe("The Brick ([B], MJG-C16): can only leave a hand at random, then revealed", () => {
  it("random discard REVEALS a Brick instead of discarding it", () => {
    const s = gameWithHand(["MJG-C16"]);
    const brick = M.player(s, 0).hand[0]!;
    expect(M.isBrick(s.instances[brick]!.cardId)).toBe(true);
    const r = E.applyIntent(s, { kind: "discardRandom", player: 0, count: 1 });
    expect(r.result).toEqual([]); // nothing actually discarded
    expect(M.player(r.state, 0).hand).toContain(brick); // still in hand (revealed)
    expect(r.state.discard).toEqual([]);
  });

  it("random discard removes a non-Brick but only reveals the Brick in the same pick", () => {
    const s = gameWithHand(["MJG-011", "MJG-C16"]);
    const [normal, brick] = M.player(s, 0).hand;
    const r = E.applyIntent(s, { kind: "discardRandom", player: 0, count: 2 });
    expect(r.result).toEqual([normal]); // only the non-Brick counts as discarded
    expect(r.state.discard).toContain(normal);
    expect(M.player(r.state, 0).hand).toEqual([brick]); // Brick stays (revealed)
  });

  it("random banish REVEALS a Brick instead of banishing it", () => {
    const s = gameWithHand(["MJG-C16"]);
    const brick = M.player(s, 0).hand[0]!;
    const r = E.applyIntent(s, { kind: "banishRandom", player: 0, count: 1 });
    expect(r.result).toEqual([]);
    expect(M.player(r.state, 0).hand).toContain(brick);
    expect(r.state.banish).toEqual([]);
  });

  it("an effect-driven banish (moveTo) REVEALS a hand Brick instead of banishing it", () => {
    const s = gameWithHand(["MJG-C16"]);
    const brick = M.player(s, 0).hand[0]!;
    const r = E.applyIntent(s, { kind: "moveTo", iid: brick, to: "banish" }).state;
    expect(M.player(r, 0).hand).toContain(brick);
    expect(r.banish).toEqual([]);
  });

  it("a non-Brick hand card still banishes normally via moveTo", () => {
    const s = gameWithHand(["MJG-011"]);
    const iid = M.player(s, 0).hand[0]!;
    const r = E.applyIntent(s, { kind: "moveTo", iid, to: "banish" }).state;
    expect(r.banish).toContain(iid);
    expect(M.player(r, 0).hand).not.toContain(iid);
  });
});

describe("reveal intent: revealed card identities are logged", () => {
  it("logs every revealed card's id with its VALUE in brackets", () => {
    const s = gameWithHand(["MJG-011", "MJG-013"]);
    const [a, b] = M.player(s, 0).hand;
    const va = M.valueOf(s, a!), vb = M.valueOf(s, b!);
    const r = E.applyIntent(s, { kind: "reveal", player: 0, iids: [a!, b!] });
    const line = r.state.log.at(-1)!;
    expect(line).toContain("reveals");
    expect(line).toContain(`MJG-011 (${va === null ? "☆" : va})`);
    expect(line).toContain(`MJG-013 (${vb === null ? "☆" : vb})`);
  });

  it("an empty reveal adds nothing to the log", () => {
    const s = gameWithHand(["MJG-011"]);
    const before = s.log.length;
    const r = E.applyIntent(s, { kind: "reveal", player: 0, iids: [] });
    expect(r.state.log.length).toBe(before);
  });
});
