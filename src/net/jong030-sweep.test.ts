import { describe, it, expect, beforeAll } from "vitest";
import * as M from "../engine/reducer.js";
import { resolveChainLink, applyIntent } from "../engine/effects.js";
import { collectTriggers } from "../engine/triggers.js";
import { battleDiscardReplacement } from "../engine/replacements.js";
import { computeAuras } from "../engine/auras.js";
import { GameSession } from "./session.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const baseSet = JSON.parse(readFileSync(join(here, "../../base_set.json"), "utf-8")) as M.Card[];

beforeAll(() => {
  M.setEffectResolver(resolveChainLink);
  M.setTriggerCollector(collectTriggers);
  M.setBattleDiscardReplacer(battleDiscardReplacement);
  M.setAuraProvider(computeAuras);
});

const mk = (iid: string, cardId = "", over: Partial<M.CardInstance> = {}): M.CardInstance => ({
  iid, cardId, atk: 1, def: 1, value: 1, tribes: [], faceDown: false, tapped: false,
  counters: {}, overlays: [], battles: 0, mods: [], ...over,
});

function fresh(): GameSession {
  let st = M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 0, cardRegistry: baseSet });
  st = M.reduce(st, { type: M.ActionType.DRAW_RESOLVES }); // -> MAIN
  return new GameSession(st);
}

describe("JONG-030 real-flow sweep (windows on)", () => {
  it("top: give prompt reaches the target through response windows (both toggles auto)", () => {
    const sess = fresh();
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, neet: mk("neet", "JONG-030", { atk: 3, def: 0, value: 3 }), keep: mk("keep") },
      players: sess.state.players.map((p) =>
        p.pid === 0 ? { ...p, hand: ["neet"] } : { ...p, hand: ["keep"] }),
    });
    sess.setToggle(0, "auto");
    sess.setToggle(1, "auto");
    const r = sess.command(0, { do: "activate", iid: "neet", role: "top", targets: ["1"] });
    expect(r.ok).toBe(true);
    // walk any response windows until the target's choice appears (cap the loop)
    for (let i = 0; i < 10 && !sess.viewFor(1).choice; i++) {
      if (sess.awaiting !== null) {
        const w = sess.awaiting;
        expect(sess.respond(w, { pass: true }).ok).toBe(true);
      } else break;
    }
    const ch = sess.viewFor(1).choice;
    expect(ch?.handPick).toBe("give");
    expect(ch?.options.length).toBeGreaterThan(0);
    // the target answers by clicking a hand card (choose with target)
    const pick = ch!.options[0]!.iid;
    expect(sess.choose(1, { use: true, target: pick }).ok).toBe(true);
    expect(M.player(sess.state, 0).hand).toContain(pick);
  });

  it("bottom Simp: the target's deck-top pick arrives and resolves (both toggles auto)", () => {
    const sess = fresh();
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances, neet: mk("neet", "JONG-030", { atk: 3, def: 0, value: 3 }),
        t0: mk("t0", "MJG-011"), t1: mk("t1", "MJG-013"), t2: mk("t2", "MJG-018"),
      },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, board: ["neet"] } : p)),
      mainDeck: ["t0", "t1", "t2", ...sess.state.mainDeck],
    });
    sess.setToggle(0, "auto");
    sess.setToggle(1, "auto");
    const r = sess.command(0, { do: "activate", iid: "neet", role: "bottom", targets: ["1"] });
    expect(r.ok).toBe(true);
    for (let i = 0; i < 10 && !sess.viewFor(1).choice; i++) {
      if (sess.awaiting !== null) {
        const w = sess.awaiting;
        expect(sess.respond(w, { pass: true }).ok).toBe(true);
      } else break;
    }
    const ch = sess.viewFor(1).choice;
    expect(ch?.options.map((o) => o.iid).sort()).toEqual(["t0", "t1", "t2"]);
    // all options are DECK cards -> the client shows the pile-viewer popup
    expect(ch?.options.every((o) => o.zone === "deck")).toBe(true);
    expect(sess.choose(1, { use: true, target: "t1" }).ok).toBe(true);
  });
});
