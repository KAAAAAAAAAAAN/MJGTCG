import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./reducer.js";
import * as E from "./effects.js";
import { CARD_SCRIPTS, getScript } from "./card-scripts.js";

const here = dirname(fileURLToPath(import.meta.url));
type Card = { id: string; abilities: { role?: string; text?: string }[] };
const baseSet = JSON.parse(readFileSync(join(here, "../../base_set.json"), "utf-8")) as Card[];
const byId = new Map(baseSet.map((c) => [c.id, c]));

describe("card-script registry integrity", () => {
  it("every script key maps to a real ability (id:role) in base_set.json", () => {
    const bad: string[] = [];
    for (const key of Object.keys(CARD_SCRIPTS)) {
      const [id, role] = key.split(":");
      const card = byId.get(id!);
      if (!card || !card.abilities.some((a) => a.role === role && (a.text ?? "").trim())) {
        bad.push(key);
      }
    }
    expect(bad).toEqual([]);
  });

  it("getScript resolves by id+role", () => {
    expect(getScript("MJG-001", "top")).toBeDefined();
    expect(getScript("MJG-001", "bottom")).toBeDefined();
    expect(getScript("MJG-001", "nope")).toBeUndefined();
    expect(getScript("ZZZ-999", "top")).toBeUndefined();
  });
});

describe("card-script behaviors (via runEffect)", () => {
  // game where the controller's hand holds `self`, with a card registry so
  // instances have real stats (not needed by these primitives, but realistic).
  function game(selfCardId = "MJG-013") {
    // self at the top so it lands in the starting hand; plenty of fillers left
    const deck = [selfCardId, ...Array<string>(15).fill("MJG-011")];
    let s = M.newGame({ players: [0], mainDeck: deck, faithDeck: 2, startingHand: 5, cardRegistry: baseSet });
    s = M.reduce(s, { type: M.ActionType.DRAW_RESOLVES }); // -> MAIN, hand 6
    const self = M.player(s, 0).hand.find((i) => s.instances[i]!.cardId === selfCardId)!;
    return { s, self };
  }

  it("ssSelf(+draw): MJG-001 top summons self and draws 1", () => {
    const { s, self } = game("MJG-001");
    const h0 = M.player(s, 0).hand.length;
    const deck0 = s.mainDeck.length;
    const out = E.runEffect(s, getScript("MJG-001", "top")!, { controller: 0, self });
    expect(M.player(out, 0).board).toContain(self);
    expect(M.player(out, 0).hand).not.toContain(self);
    expect(M.player(out, 0).hand.length).toBe(h0); // -1 summon, +1 draw
    expect(out.mainDeck.length).toBe(deck0 - 1);
  });

  it("ssSelf (no draw): MJG-013 top summons self only", () => {
    const { s, self } = game("MJG-013");
    const deck0 = s.mainDeck.length;
    const out = E.runEffect(s, getScript("MJG-013", "top")!, { controller: 0, self });
    expect(M.player(out, 0).board).toContain(self);
    expect(out.mainDeck.length).toBe(deck0); // no draw
  });

  it("ssSelf(+draw 2): MJG-C17 top draws two", () => {
    const { s, self } = game("MJG-C17");
    const deck0 = s.mainDeck.length;
    const out = E.runEffect(s, getScript("MJG-C17", "top")!, { controller: 0, self });
    expect(M.player(out, 0).board).toContain(self);
    expect(out.mainDeck.length).toBe(deck0 - 2);
  });

  it("summonTop: MJG-001 bottom summons the top of the Main deck", () => {
    const { s, self } = game("MJG-001");
    const top = s.mainDeck[0]!;
    const out = E.runEffect(s, getScript("MJG-001", "bottom")!, { controller: 0, self });
    expect(M.player(out, 0).board).toContain(top);
  });

  it("NYA-001 'nya' (a Faith-deck card): discards self and Special Summons a 1/1/1 BIG ICHIHIME", () => {
    // NYA-001 lives in the FAITH deck; deal it there and draw it into hand as in a real game
    let s = M.newGame({ players: [0], mainDeck: Array<string>(6).fill("MJG-011"), faithDeck: ["NYA-001"], startingHand: 3, cardRegistry: baseSet });
    s = E.applyIntent(s, { kind: "draw", player: 0, count: 1, deck: "faith" }).state;
    const self = M.player(s, 0).hand.find((i) => s.instances[i]!.cardId === "NYA-001")!;
    const out = E.runEffect(s, getScript("NYA-001", "top")!, { controller: 0, self });
    expect(M.player(out, 0).hand).not.toContain(self); // this card is discarded
    expect(out.discard).toContain(self);
    const board = M.player(out, 0).board;
    expect(board.length).toBe(1); // just the token
    const tok = out.instances[board[0]!]!;
    expect(tok.cardId).toBe("NYA-000"); // BIG ICHIHIME
    expect(tok.iid).not.toBe(self); // a freshly minted token, not the activator
    expect([tok.atk, tok.def, tok.value]).toEqual([1, 1, 1]); // 1/1/1 vanilla
    expect(tok.token).toBe(true); // minted tokens are badged in the UI
  });

  it("reveal-this-card effects log the reveal (MJG-002 top, MJG-047 top)", () => {
    for (const id of ["MJG-002", "MJG-047"]) {
      const { s, self } = game(id);
      const out = E.runEffect(s, getScript(id, "top")!, { controller: 0, self });
      expect(out.log.some((l) => l.includes("reveals") && l.includes(id))).toBe(true);
    }
  });

  it("FAT-009 bottom logs the revealed top 3 of the deck", () => {
    const { s, self } = game("FAT-009");
    const top3 = s.mainDeck.slice(0, 3).map((iid) => s.instances[iid]!.cardId);
    const out = E.runEffect(s, getScript("FAT-009", "bottom")!, { controller: 0, self });
    const line = out.log.find((l) => l.includes("reveals"));
    expect(line).toBeDefined();
    for (const cid of top3) expect(line).toContain(cid);
  });

  it("drawN faith: MJG-888 bottom draws 1 from the Faith deck", () => {
    const { s, self } = game("MJG-888");
    const f0 = s.faithDeck.length;
    const out = E.runEffect(s, getScript("MJG-888", "bottom")!, { controller: 0, self });
    expect(out.faithDeck.length).toBe(f0 - 1);
  });

  // --- targeting batch (slice 2): target read from ctx.targets ---
  const mk = (iid: string, over: Partial<M.CardInstance> = {}): M.CardInstance => ({
    iid, cardId: "", atk: 1, def: 1, value: 1, tribes: [], faceDown: false,
    tapped: false, counters: {}, overlays: [], battles: 0, mods: [], ...over,
  });
  function place(s: M.GameState, where: "hand" | "board", pid: number, ci: M.CardInstance): M.GameState {
    s = M.replace(s, { instances: { ...s.instances, [ci.iid]: ci } });
    return M.replace(s, {
      players: s.players.map((p) =>
        p.pid === pid ? { ...p, [where]: [...p[where], ci.iid] } : p,
      ),
    });
  }
  const blank = () => M.newGame({ players: [0, 1], mainDeck: 6 });
  const run = (s: M.GameState, key: string, b: { self: string; targets: string[] }) =>
    E.runEffect(s, getScript(...(key.split(":") as [string, string]))!, { controller: 0, ...b });

  it("Mr Rabbit (MJG-018:bottom): returns target to its OWNER's hand", () => {
    let s = blank();
    s = place(s, "board", 1, mk("tgt")); // target sits on opponent (p1) board
    const out = run(s, "MJG-018:bottom", { self: "self", targets: ["tgt"] });
    expect(M.player(out, 1).hand).toContain("tgt"); // back to p1 (owner), not p0
    expect(M.player(out, 1).board).not.toContain("tgt");
  });

  it("TO Here (AS4-PIN:top): discard self, place target on bottom of Main deck", () => {
    let s = blank();
    s = place(s, "hand", 0, mk("self"));
    s = place(s, "board", 0, mk("tgt"));
    const out = run(s, "AS4-PIN:top", { self: "self", targets: ["tgt"] });
    expect(out.discard[0]).toBe("self");
    expect(out.mainDeck[out.mainDeck.length - 1]).toBe("tgt");
  });

  it("MADO (MJG-C33:top): banish target, then Special Summon self", () => {
    let s = blank();
    s = place(s, "hand", 0, mk("self"));
    s = place(s, "board", 0, mk("tgt"));
    const out = run(s, "MJG-C33:top", { self: "self", targets: ["tgt"] });
    expect(out.banish[0]).toBe("tgt");
    expect(M.player(out, 0).board).toContain("self");
  });

  it("Shamiko (SHA-001:top): discard the target", () => {
    let s = blank();
    s = place(s, "board", 1, mk("tgt", { def: 0 }));
    const out = run(s, "SHA-001:top", { self: "self", targets: ["tgt"] });
    expect(out.discard[0]).toBe("tgt");
  });

  it("RAWN (MJG-M06:top): discard self (top), target to bottom of discard", () => {
    let s = blank();
    s = place(s, "hand", 0, mk("self"));
    s = place(s, "board", 0, mk("tgt"));
    const out = run(s, "MJG-M06:top", { self: "self", targets: ["tgt"] });
    expect(out.discard[0]).toBe("self");
    expect(out.discard[out.discard.length - 1]).toBe("tgt");
  });

  it("drawN(12): MJG-C14 bottom draws 12 from Main", () => {
    // need a big enough main deck
    let s = M.newGame({ players: [0], mainDeck: 30, startingHand: 5 });
    s = M.reduce(s, { type: M.ActionType.DRAW_RESOLVES });
    const h0 = M.player(s, 0).hand.length;
    const deck0 = s.mainDeck.length;
    const self = M.player(s, 0).hand[0]!;
    const out = E.runEffect(s, getScript("MJG-C14", "bottom")!, { controller: 0, self });
    expect(M.player(out, 0).hand.length).toBe(h0 + 12);
    expect(out.mainDeck.length).toBe(deck0 - 12);
  });
});
