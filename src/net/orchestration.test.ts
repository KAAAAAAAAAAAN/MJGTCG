import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "../engine/reducer.js";
import { resolveChainLink, applyIntent } from "../engine/effects.js";
import { collectTriggers } from "../engine/triggers.js";
import { battleDiscardReplacement } from "../engine/replacements.js";
import { computeAuras } from "../engine/auras.js";
import { ACTIVATIONS, type LegalAction as LA } from "../engine/legal.js";
import { GameSession } from "./session.js";

const here = dirname(fileURLToPath(import.meta.url));
const baseSet = JSON.parse(readFileSync(join(here, "../../base_set.json"), "utf-8")) as M.Card[];

beforeAll(() => {
  M.setEffectResolver(resolveChainLink);
  M.setTriggerCollector(collectTriggers);
  M.setBattleDiscardReplacer(battleDiscardReplacement);
  M.setAuraProvider(computeAuras);
  // Banana (MJG-013) has a real script (SS this card); mark it activatable
  // "anytime" so it can be used both on your turn AND as a response.
  ACTIVATIONS["MJG-013:top"] = { from: "hand", speed: "anytime" };
  M.setRegistry({
    "MJG-013:top": { parsed: { flags: { at_any_time: true } } },
    "MJG-002:top": { parsed: { flags: { once_per_turn: true } } }, // Look at this Hag!
    "MJG-002:bottom": { parsed: { flags: { once_per_turn: true } } }, // >dama (hard once per turn)
    "UGR-005:top": { parsed: { flags: { at_any_time: true } } }, // Miko (battle-discard hand-trap)
    "MJG-029:top": { parsed: { flags: { at_any_time: true } } }, // Yuzu (+1 Image, SS to any board)
    "MJG-77*:top": { parsed: { flags: { at_any_time: true } } }, // YUZU GRAPE (Correction)
    "MJG-021:top": { parsed: { flags: { at_any_time: true } } }, // Justice for Lalatano (draw-negate hand-trap)
    "MJG-026:top": { parsed: { flags: { at_any_time: true } } }, // Bravo (SPELL/ACTIVE-negate hand-trap)
    "MJG-047:top": { parsed: { flags: { at_any_time: true } } }, // Jane4 (Useless Censors — repeatable)
    "MJG-M02:top": { parsed: { flags: { at_any_time: true } } }, // I'm at the bar... (Siscon)
    "MJG-M04:bottom": { parsed: { flags: { once_per_game: true } } }, // RUSSIAN (Target Ron)
    "MJG-M09:top": { parsed: { flags: { at_any_time: true } } }, // It's Actually Over (Tie the Noose)
    "MJG-M10:top": { parsed: { flags: { at_any_time: true } } }, // GrinchChads (Game Limit)
    "MJG-M19:top": { parsed: { flags: { at_any_time: true } } }, // Flow Book 1 (Tile Efficiency)
    "MJG-M21:top": { parsed: { flags: { at_any_time: true } } }, // The Jongker (BAAAANG)
    "MTG-001:top": { parsed: { flags: { at_any_time: true } } }, // Counterspell (Mono Blue)
    "MOON-001:bottom": { parsed: { flags: { once_per_game: true } } }, // Mooncakes (Soulless)
    "MJG-HAT:top": { parsed: { flags: { at_any_time: true } } }, // FU-FU-FUCK SHAMIKO (keikumusume)
    "MJG-C04:top": { parsed: { flags: { at_any_time: true } } }, // All My Mahjong Friends Have Died (Shoumakyou)
    "MJG-M13:top": { parsed: { flags: { at_any_time: true } } }, // Famous Fagat (Trap Trick)
    "MJG-C31:top": { parsed: { flags: { at_any_time: true } } }, // Koito (Easily Startled — reveal-hand negate)
    "MJG-C33:top": { parsed: { flags: { at_any_time: true } } }, // Madoka (Cold Attitude — banish own + SS)
    "MJG-C34:top": { parsed: { flags: { at_any_time: true } } }, // No (Solem — meld-cost negate hand-trap)
    "MJG-040:top": { parsed: { flags: { once_per_player: true } } }, // Crimson Chemist (A Worthy Disciple — modal)
    "MJG-C13:bottom": { parsed: { flags: { once_per_turn: true } } }, // Magical Sands (The Second Hand)
    "MJG-C14:bottom": { parsed: { flags: { once_per_turn: true } } }, // Waschizo (WASHI NO IIPIN — draw 12)
    // parsed steps so abilityDraws() sees these as draw effects (mirrors base_set_parsed)
    "MJG-003:bottom": { parsed: { steps: [{ actions: ["draw"] }] } }, // Koromo Janai zo! (draw deck bottom)
    "MJG-021:bottom": { parsed: { steps: [{ actions: ["draw", "add_counter"] }] } }, // Hitsuji ga Ippiki
  });
});

const mk = (iid: string, cardId = "", over: Partial<M.CardInstance> = {}): M.CardInstance => ({
  iid, cardId, atk: 1, def: 1, value: 1, tribes: [], faceDown: false,
  tapped: false, counters: {}, overlays: [], battles: 0, mods: [], ...over,
});
/** seat-0 game in MAIN_PHASE; place crafted cards via `add`. */
/** Answer every pending mass-discard ORDER prompt by taking the first option
 *  (order-agnostic tests just need the cards to fall). Returns how many it answered. */
function drainMass(sess: GameSession): number {
  let n = 0;
  for (let guard = 0; guard < 200; guard++) {
    const seat = sess.state.players.map((p) => p.pid).find((pid) => sess.viewFor(pid).choice?.massPick);
    if (seat === undefined) break;
    const opt = sess.viewFor(seat).choice!.options[0]!.iid;
    sess.choose(seat, { use: true, target: opt });
    n++;
  }
  return n;
}

function setup(add: (place: (where: "hand" | "board", pid: number, ci: M.CardInstance) => void) => void): M.GameState {
  let s = M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 0, cardRegistry: baseSet });
  s = M.reduce(s, { type: M.ActionType.DRAW_RESOLVES }); // -> MAIN
  add((where, pid, ci) => {
    s = M.replace(s, { instances: { ...s.instances, [ci.iid]: ci } });
    s = M.replace(s, { players: s.players.map((p) => (p.pid === pid ? { ...p, [where]: [...p[where], ci.iid] } : p)) });
  });
  return s;
}

describe("priority orchestration — off toggle (auto-resolve)", () => {
  it("begin() opens the starting-hands window, then settles to the first draw", () => {
    const sess = new GameSession(M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 5, cardRegistry: baseSet }));
    expect(sess.begin().ok).toBe(true);
    expect(sess.state.phase).toBe(M.Phase.TURN_START_DRAW); // no responders -> first draw
    expect(sess.awaiting).toBeNull();
  });

  it("the starting-hands window is OPEN: 'always' is prompted there, 'auto' is not (phase window)", () => {
    const make = () => {
      let st = M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 0, cardRegistry: baseSet });
      st = M.replace(st, { instances: { ...st.instances, yz: mk("yz", "MJG-013") } });
      st = M.replace(st, { players: st.players.map((p) => (p.pid === 1 ? { ...p, hand: [...p.hand, "yz"] } : p)) });
      return new GameSession(st);
    };
    const onSess = make();
    onSess.setToggle(1, "always");
    onSess.begin();
    expect(onSess.awaiting).toBe(1); // "always" stops at any open window with a response

    const autoSess = make();
    autoSess.setToggle(1, "auto");
    autoSess.begin();
    expect(autoSess.awaiting).toBeNull(); // "auto" reacts to opponent actions, not phase windows
  });

  it("draw-for-turn opens a (transparent) start-of-turn window, then MAIN", () => {
    const sess = new GameSession(M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 0, cardRegistry: baseSet }));
    expect(sess.state.phase).toBe(M.Phase.TURN_START_DRAW);
    sess.command(0, { do: "draw" });
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE); // start-of-turn window auto-passed
    expect(M.player(sess.state, 0).hand.length).toBe(1);
    expect(sess.awaiting).toBeNull();
  });

  it("end-of-turn triggers fire on endTurn (Sprout draws 1)", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("spr", "MJG-014"))));
    const h0 = M.player(sess.state, 0).hand.length;
    sess.command(0, { do: "endTurn" });
    expect(M.player(sess.state, 0).hand.length).toBe(h0 + 1); // end-of-turn window resolved Sprout
    expect(sess.state.phase).toBe(M.Phase.TURN_END);
  });

  it("Cheese Chotto top: optional trigger prompts, then SS the chosen 'TO Here'", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("chio", "MJG-003"));
        p("hand", 0, mk("th", "AS4-PIN")); // "TO Here" in hand
      }),
    );
    sess.command(0, { do: "summon", iid: "chio" });
    const choice = sess.viewFor(0).choice; // controller is prompted (use? which copy?)
    expect(choice?.effectId).toBe("MJG-003:top");
    expect(choice?.options.map((o) => o.iid)).toContain("th");
    sess.choose(0, { use: true, target: "th" });
    expect(M.player(sess.state, 0).board).toContain("th"); // chosen copy special-summoned
  });

  it("optional trigger spawned MID-CHAIN-RESOLUTION still prompts", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("ny", "MJG-001")); // Nyagger: Active SS's the deck top
      p("hand", 0, mk("th", "AS4-PIN")); // a "TO Here" candidate for the summoned card's trigger
    }));
    // put a Cheese Chotto on top of the deck — Nyagger's Active will summon it,
    // and its optional summon trigger should prompt while the chain is resolving
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, chio: mk("chio", "MJG-003") },
      mainDeck: ["chio", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "ny", role: "bottom" });
    expect(M.player(sess.state, 0).board).toContain("chio"); // summoned mid-resolution
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-003:top"); // its optional trigger prompts
    sess.choose(0, { use: true, target: "th" });
    expect(M.player(sess.state, 0).board).toContain("th");
  });

  it("Cheese Chotto top: declining the optional trigger summons nothing", () => {
    const sess = new GameSession(setup((p) => { p("hand", 0, mk("chio", "MJG-003")); p("hand", 0, mk("th", "AS4-PIN")); }));
    sess.command(0, { do: "summon", iid: "chio" });
    sess.choose(0, { use: false });
    expect(M.player(sess.state, 0).board).not.toContain("th");
    expect(sess.viewFor(0).choice).toBeNull();
  });

  it("Cheese Chotto top: not offered (no prompt) when no 'TO Here' exists", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("chio", "MJG-003"))));
    sess.command(0, { do: "summon", iid: "chio" });
    expect(sess.viewFor(0).choice).toBeNull(); // illegal -> skipped, no prompt
    expect(M.player(sess.state, 0).board).toContain("chio");
  });

  it("TO Here top: discard self + place a targeted character on the bottom of the deck", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("th", "AS4-PIN"));
        p("board", 1, mk("victim", "MJG-011", { value: 1 })); // a character to target
      }),
    );
    const deckLen = sess.state.mainDeck.length;
    expect(sess.command(0, { do: "activate", iid: "th", role: "top", targets: ["victim"] }).ok).toBe(true);
    expect(M.player(sess.state, 0).hand).not.toContain("th"); // discarded itself
    expect(sess.state.discard).toContain("th");
    expect(M.player(sess.state, 1).board).not.toContain("victim"); // bounced off the board
    expect(sess.state.mainDeck[sess.state.mainDeck.length - 1]).toBe("victim"); // to the deck bottom
    expect(sess.state.mainDeck.length).toBe(deckLen + 1);
  });

  it("TO Here bottom: CHOOSE a discarded card -> top, then optionally return self (on resolution)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("th", "AS4-PIN"));
        p("hand", 0, mk("trash", "MJG-011"));
      }),
    );
    // seed the discard with two cards; "buried" is NOT on top
    sess.state = M.replace(sess.state, { discard: ["ontop", "buried"], instances: { ...sess.state.instances, ontop: mk("ontop", "MJG-012"), buried: mk("buried", "MJG-013") } });
    // activate with NO target/opt — both are decided at resolution
    expect(sess.command(0, { do: "activate", iid: "th", role: "bottom" }).ok).toBe(true);
    expect(sess.viewFor(0).choice?.effectId).toBe("AS4-PIN:bottom"); // step 1: choose a discarded card
    sess.choose(0, { use: true, target: "buried" });
    expect(sess.viewFor(0).choice?.prompt).toBe("Return this card to your hand?"); // step 2: optional
    sess.choose(0, { use: true });
    expect(sess.state.discard[0]).toBe("buried"); // chosen card moved to the top
    expect(M.player(sess.state, 0).hand).toContain("th"); // opt=true -> returned to hand
    expect(M.player(sess.state, 0).board).not.toContain("th");
    expect(M.inst(sess.state, "th").tapped).toBe(false); // tapped by its Active, untapped on leaving play
  });

  it("TO Here bottom: declining the optional return keeps this card on the board", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("th", "AS4-PIN"))));
    sess.state = M.replace(sess.state, { discard: ["d0"], instances: { ...sess.state.instances, d0: mk("d0", "MJG-012") } });
    sess.command(0, { do: "activate", iid: "th", role: "bottom" });
    sess.choose(0, { use: true, target: "d0" }); // choose the discarded card
    sess.choose(0, { use: false }); // decline the return
    expect(M.player(sess.state, 0).board).toContain("th"); // stays on board (tapped)
    expect(M.inst(sess.state, "th").tapped).toBe(true);
  });

  it("TO Here top: rejected without a valid character target", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("th", "AS4-PIN"))));
    // no characters on any board -> not even offered
    expect(sess.command(0, { do: "activate", iid: "th", role: "top", targets: [] }).ok).toBe(false);
  });

  it("Cheese Chotto bottom: draws the BOTTOM card of the deck; taps", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("chio", "MJG-003"))));
    const bottom = sess.state.mainDeck[sess.state.mainDeck.length - 1];
    const h0 = M.player(sess.state, 0).hand.length;
    expect(sess.command(0, { do: "activate", iid: "chio", role: "bottom" }).ok).toBe(true);
    expect(M.player(sess.state, 0).hand).toContain(bottom);
    expect(M.player(sess.state, 0).hand.length).toBe(h0 + 1);
    expect(M.inst(sess.state, "chio").tapped).toBe(true); // using the Active taps it
  });

  it("a summon resolves with no manual steps, no prompt", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("v", "MJG-011"))));
    const r = sess.command(0, { do: "summon", iid: "v" });
    expect(r.ok).toBe(true);
    expect(sess.awaiting).toBeNull();
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE);
    expect(M.player(sess.state, 0).board).toContain("v");
  });

  it("an activated effect auto-resolves (Banana SS's itself)", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("ban", "MJG-013"))));
    sess.command(0, { do: "activate", iid: "ban", role: "top" });
    expect(sess.awaiting).toBeNull();
    expect(M.player(sess.state, 0).board).toContain("ban");
  });

  it("Nyagger top: as your first action, SS itself from hand then draw 1", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("ny", "MJG-001"))));
    const handBefore = M.player(sess.state, 0).hand.length; // opaque draw + ny
    expect(sess.command(0, { do: "activate", iid: "ny", role: "top" }).ok).toBe(true);
    expect(sess.awaiting).toBeNull();
    expect(M.player(sess.state, 0).board).toContain("ny"); // special summoned to board
    expect(M.player(sess.state, 0).hand.length).toBe(handBefore); // -1 ny to board, +1 draw
    expect(M.player(sess.state, 0).actedThisTurn).toBe(true);
    // after acting, a fresh Nyagger in hand is no longer a legal first-action play
    const sess2 = new GameSession(setup((p) => { p("hand", 0, mk("v", "MJG-011")); p("hand", 0, mk("ny2", "MJG-001")); }));
    sess2.command(0, { do: "summon", iid: "v" }); // take an action first
    expect(sess2.command(0, { do: "activate", iid: "ny2", role: "top" }).ok).toBe(false);
  });

  it("Look at this Hag! top: all players draw 1, anticlockwise; once per turn", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("hag", "MJG-002"))));
    const h0 = M.player(sess.state, 0).hand.length;
    const h1 = M.player(sess.state, 1).hand.length;
    const deck = sess.state.mainDeck.length;
    expect(sess.command(0, { do: "activate", iid: "hag", role: "top" }).ok).toBe(true);
    expect(M.player(sess.state, 0).hand.length).toBe(h0 + 1); // drew 1 (hag stays in hand)
    expect(M.player(sess.state, 1).hand.length).toBe(h1 + 1);
    expect(sess.state.mainDeck.length).toBe(deck - 2);
    expect(M.player(sess.state, 0).hand).toContain("hag"); // revealed & returned to hand
    // (once per turn) -> a second activation is rejected
    expect(sess.command(0, { do: "activate", iid: "hag", role: "top" }).ok).toBe(false);
  });

  it("Look at this Hag! >dama: special meld from hand; HARD once per turn across copies", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("hag1", "MJG-002")); // two copies of the active source
        p("board", 0, mk("hag2", "MJG-002"));
        p("hand", 0, mk("a", "", { value: 5 }));
        p("hand", 0, mk("b", "", { value: 5 }));
        p("hand", 0, mk("c", "", { value: 5 }));
        p("hand", 0, mk("d", "", { value: 1 }));
        p("hand", 0, mk("e", "", { value: 2 }));
        p("hand", 0, mk("f", "", { value: 3 }));
      }),
    );
    expect(sess.command(0, { do: "meld", materials: ["a", "b", "c"], source: "hag1" }).ok).toBe(true);
    const me = M.player(sess.state, 0);
    expect(me.meldZone.length).toBe(1);
    expect(me.meldZone[0]!.kind).toBe("triplet");
    expect(me.hand).not.toContain("a"); // moved from hand into the meld zone
    expect(me.meldedThisTurn).toBe(false); // special meld -> normal meld still available
    expect(M.inst(sess.state, "hag1").tapped).toBe(true); // using the active taps it
    // HARD once per turn: the second (untapped) copy can't fire >dama either
    expect(M.inst(sess.state, "hag2").tapped).toBe(false);
    expect(sess.command(0, { do: "meld", materials: ["d", "e", "f"], source: "hag2" }).ok).toBe(false);
  });

  it("using an on-board ACTIVE taps the card; tapped -> can't reuse; untaps on advance", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("ny", "MJG-001")))); // Nyagger Active
    expect(M.inst(sess.state, "ny").tapped).toBe(false);
    expect(sess.command(0, { do: "activate", iid: "ny", role: "bottom" }).ok).toBe(true);
    expect(M.inst(sess.state, "ny").tapped).toBe(true); // tapped by using its Active
    expect(sess.command(0, { do: "activate", iid: "ny", role: "bottom" }).ok).toBe(false); // tapped -> illegal
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" }); // untaps the (old) active player's board
    expect(M.inst(sess.state, "ny").tapped).toBe(false);
  });

  it("a registered conditional spell activates when legal and is rejected when not", () => {
    // p*n*s (MJG-041): only with the strictly biggest hand
    const sess = new GameSession(setup((p) => p("hand", 0, mk("pen", "MJG-041"))));
    // seat0 hand=2 (drawn + pen), seat1 hand=0 -> legal
    const ok = sess.command(0, { do: "activate", iid: "pen", role: "top" });
    expect(ok.ok).toBe(true);
    expect(M.player(sess.state, 0).board).toContain("pen");

    // now seat0 is not biggest -> server rejects the activation
    const sess2 = new GameSession(
      setup((p) => {
        p("hand", 0, mk("pen2", "MJG-041"));
        p("hand", 1, mk("a"));
        p("hand", 1, mk("b"));
        p("hand", 1, mk("c"));
      }),
    );
    const bad = sess2.command(0, { do: "activate", iid: "pen2", role: "top" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/illegal activate/);
  });

  it("Miko (UGR-005) bottom: a battle discard of your card is redirected to Miko", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 1, def: 1 })); // your attacker would lose
        p("board", 0, mk("miko", "UGR-005")); // Mandatory passive on your board
        p("board", 1, mk("def", "", { atk: 5, def: 5 })); // strong defender
      }),
    );
    sess.command(0, { do: "attack", attacker: "att", target: "def" });
    expect(M.player(sess.state, 0).board).toContain("att"); // saved
    expect(M.player(sess.state, 0).board).not.toContain("miko"); // discarded instead
    expect(sess.state.discard).toContain("miko");
  });

  it("Miko (UGR-005) top hand-trap: opponent is prompted in the battle-discard window and saves their card", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 5, def: 5 })); // your strong attacker
        p("board", 1, mk("def", "", { atk: 1, def: 1 })); // opponent's losing defender
        p("hand", 1, mk("miko", "UGR-005")); // opponent holds the hand-trap
      }),
    );
    sess.setToggle(1, "auto");
    sess.command(0, { do: "attack", attacker: "att", target: "def" });
    // not prompted at declaration (condition isn't met yet) — only once the battle
    // would discard their card does the discard window prompt the defender.
    expect(sess.awaiting).toBe(1);
    sess.respond(1, { activate: { iid: "miko", role: "top" } });
    expect(M.player(sess.state, 1).board).toContain("def"); // saved by the replacement
    expect(M.player(sess.state, 1).board).toContain("miko"); // summoned instead
    expect(sess.state.discard).not.toContain("def");
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE);
  });

  it("Miko top: with the chain toggle OFF the holder isn't prompted and the card is discarded", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 5, def: 5 }));
        p("board", 1, mk("def", "", { atk: 1, def: 1 }));
        p("hand", 1, mk("miko", "UGR-005"));
      }),
    );
    // seat 1 toggle defaults to "off" -> auto-pass the battle-discard window
    sess.command(0, { do: "attack", attacker: "att", target: "def" });
    expect(sess.awaiting).toBeNull();
    expect(sess.state.discard).toContain("def"); // discarded normally
    expect(M.player(sess.state, 1).hand).toContain("miko"); // hand-trap unused
  });

  it("Dnruk top 'Tipsy': at end of your turn, draw 2 then discard 1 random (mandatory)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("dnk", "MJG-006"));
        p("hand", 0, mk("keep")); // one card already in hand
      }),
    );
    const deck0 = sess.state.mainDeck.length;
    const hand0 = M.player(sess.state, 0).hand.length;
    sess.command(0, { do: "endTurn" });
    expect(M.player(sess.state, 0).hand.length).toBe(hand0 + 2 - 1); // draw 2, discard 1
    expect(sess.state.discard.length).toBe(1);
    expect(sess.state.mainDeck.length).toBe(deck0 - 2);
    expect(sess.awaiting).toBeNull(); // mandatory: no prompt
    expect(sess.state.phase).toBe(M.Phase.TURN_END);
  });

  it("Dnruk bottom 'SEX': pools both hands, shuffles, re-deals original counts", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("dnk", "MJG-006"));
        p("hand", 0, mk("a1")); p("hand", 0, mk("a2")); // seat 0: 2 cards
        p("hand", 1, mk("b1")); p("hand", 1, mk("b2")); p("hand", 1, mk("b3")); // seat 1: 3 cards
      }),
    );
    const b0 = [...M.player(sess.state, 0).hand];
    const b1 = [...M.player(sess.state, 1).hand];
    sess.command(0, { do: "activate", iid: "dnk", role: "bottom", targets: ["1"] });
    const h0 = M.player(sess.state, 0).hand;
    const h1 = M.player(sess.state, 1).hand;
    expect(h0.length).toBe(b0.length); // original counts restored
    expect(h1.length).toBe(b1.length);
    expect([...h0, ...h1].sort()).toEqual([...b0, ...b1].sort()); // pool conserved, just redistributed
    expect(sess.state.instances["dnk"]?.tapped).toBe(true); // Active tapped on use
  });

  it("Yuzu (MJG-029) bottom 'First for Yuzu!': a battle-discarded Yuzu goes to deck top instead", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("yz", "MJG-029", { atk: 1, def: 1 })); // your Yuzu attacks and would lose
        p("board", 1, mk("def", "", { atk: 5, def: 5 }));
      }),
    );
    sess.command(0, { do: "attack", attacker: "yz", target: "def" });
    expect(M.player(sess.state, 0).board).not.toContain("yz"); // left the board
    expect(sess.state.discard).not.toContain("yz"); // NOT discarded
    expect(sess.state.mainDeck[0]).toBe("yz"); // placed on top of the deck instead
  });

  it("Yuzu top '+1 Image': the board is CHOSEN on resolution, not targeted at activation", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("yz", "MJG-029"))));
    sess.command(0, { do: "activate", iid: "yz", role: "top" }); // no target at activation
    const ch = sess.viewFor(0).choice;
    expect(ch?.effectId).toBe("MJG-029:top"); // controller is prompted at resolution
    expect(ch?.mandatory).toBe(true); // must choose a board (no skip)
    sess.choose(0, { use: true, target: "1" }); // choose the opponent's board
    expect(M.player(sess.state, 1).board).toContain("yz");
    expect(M.player(sess.state, 0).hand).not.toContain("yz");

    const sess2 = new GameSession(setup((p) => p("hand", 0, mk("yz2", "MJG-029"))));
    sess2.command(0, { do: "activate", iid: "yz2", role: "top" });
    sess2.choose(0, { use: true, target: "0" }); // choose your own board
    expect(M.player(sess2.state, 0).board).toContain("yz2");
  });

  it("two Yuzus chain: each chooses its board on resolution; both resolve", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("yz1", "MJG-029"));
        p("hand", 0, mk("yz2", "MJG-029"));
      }),
    );
    sess.setToggle(0, "always"); // responding to your OWN action needs "always"
    sess.command(0, { do: "activate", iid: "yz1", role: "top" }); // no target
    expect(sess.awaiting).toBe(0);
    sess.respond(0, { activate: { iid: "yz2", role: "top" } }); // chain the second (no target)
    sess.choose(0, { use: true, target: "0" }); // yz2 resolves first (LIFO): choose board
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-029:top"); // then yz1 prompts
    sess.choose(0, { use: true, target: "0" });
    const board = M.player(sess.state, 0).board;
    expect(board).toContain("yz1"); // both summoned
    expect(board).toContain("yz2");
  });

  it("an illegal response activation is rejected up front, leaving the seat awaiting", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("yz1", "MJG-029"));
        p("hand", 0, mk("yz2", "MJG-029"));
      }),
    );
    sess.setToggle(0, "always"); // prompted to chain to your own action
    sess.command(0, { do: "activate", iid: "yz1", role: "top" });
    expect(sess.awaiting).toBe(0);
    const r = sess.respond(0, { activate: { iid: "ghost", role: "top" } }); // no such card
    expect(r.ok).toBe(false); // validated and rejected
    expect(sess.awaiting).toBe(0); // awaiting preserved -> retryable
  });

  it("'always' prompts at a non-reactive window (your own action) where 'auto' would not", () => {
    // seat 0 activates its OWN quick effect; only "always" re-prompts the actor to
    // chain another to itself ("auto" reacts to opponents only).
    const mkSess = () => new GameSession(setup((p) => {
      p("hand", 0, mk("a", "MJG-013"));
      p("hand", 0, mk("b", "MJG-013")); // a second legal response in hand
    }));
    const onSess = mkSess();
    onSess.setToggle(0, "always");
    onSess.command(0, { do: "activate", iid: "a", role: "top" });
    expect(onSess.awaiting).toBe(0); // "always" stops on your own action

    const autoSess = mkSess();
    autoSess.setToggle(0, "auto");
    autoSess.command(0, { do: "activate", iid: "a", role: "top" });
    expect(autoSess.awaiting).toBeNull(); // "auto" does not prompt for your own action
  });

  it("a declared attack is visible to all players (attacker -> target)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 5, def: 5 }));
        p("board", 1, mk("def", "", { atk: 1, def: 1 }));
        p("hand", 1, mk("ban", "MJG-013")); // a response holds the declaration window open
      }),
    );
    sess.setToggle(1, "auto");
    sess.command(0, { do: "attack", attacker: "att", target: "def" });
    expect(sess.awaiting).toBe(1);
    expect(sess.viewFor(1).pending.battle).toEqual({ attacker: "att", target: "def" });
  });

  it("an activated card is public: its identity is revealed to opponents on the chain", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("yz", "MJG-029")); // activated from hand
        p("hand", 1, mk("ban", "MJG-013")); // response holds the window open
      }),
    );
    sess.setToggle(1, "auto");
    sess.command(0, { do: "activate", iid: "yz", role: "top" });
    expect(sess.awaiting).toBe(1);
    const stack = sess.viewFor(1).stack; // opponent's view
    expect(stack).toHaveLength(1);
    expect(stack[0]!.card.cardId).toBe("MJG-029"); // identity now public
    expect(stack[0]!.controller).toBe(0);
  });

  it("a pending effect target is visible to all players", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("th", "AS4-PIN"));
        p("board", 1, mk("victim", "MJG-011", { value: 1 }));
        p("hand", 1, mk("ban", "MJG-013")); // response holds the window open
      }),
    );
    sess.setToggle(1, "auto");
    sess.command(0, { do: "activate", iid: "th", role: "top", targets: ["victim"] });
    expect(sess.awaiting).toBe(1);
    expect(sess.viewFor(1).pending.targets).toContain("victim"); // opponent sees the target
  });

  it("Correction (MJG-77*) top: SS this card, then banish the targeted 1-DEF character", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("kavi", "MJG-77*"));
        p("board", 1, mk("weak", "", { atk: 1, def: 1 })); // DEF 1 -> targetable
      }),
    );
    expect(sess.command(0, { do: "activate", iid: "kavi", role: "top", targets: ["weak"] }).ok).toBe(true);
    expect(M.player(sess.state, 0).board).toContain("kavi"); // special-summoned
    expect(sess.state.banish).toContain("weak"); // target banished
    expect(M.player(sess.state, 1).board).not.toContain("weak");
  });

  it("Fortune Telling (MJG-77*) bottom: reorder the top 4 of the deck (private to the controller)", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("kavi", "MJG-77*"))));
    sess.state = M.replace(sess.state, {
      mainDeck: ["t0", "t1", "t2", "t3", ...sess.state.mainDeck],
      instances: { ...sess.state.instances, t0: mk("t0", "MJG-011"), t1: mk("t1", "MJG-012"), t2: mk("t2", "MJG-013"), t3: mk("t3", "MJG-014") },
    });
    sess.command(0, { do: "activate", iid: "kavi", role: "bottom" });
    // the controller is shown the top 4; opponents are not (private peek)
    expect(sess.viewFor(0).choice?.options.map((o) => o.iid).sort()).toEqual(["t0", "t1", "t2", "t3"]);
    expect(sess.viewFor(1).choice).toBeNull();
    // a malformed order (not a permutation of the offered cards) is rejected
    expect(sess.choose(0, { use: true, order: ["t3", "t3", "t2", "t1"] }).ok).toBe(false);
    // the client stages the full order locally and submits it once
    sess.choose(0, { use: true, order: ["t3", "t2", "t1", "t0"] });
    expect(sess.state.mainDeck.slice(0, 4)).toEqual(["t3", "t2", "t1", "t0"]);
  });

  it("Correction: a non-1-DEF character can't be targeted (effect not offered)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("kavi", "MJG-77*"));
        p("board", 1, mk("tough", "", { atk: 2, def: 3 })); // DEF 3 -> not a valid target
      }),
    );
    expect(sess.command(0, { do: "activate", iid: "kavi", role: "top", targets: ["tough"] }).ok).toBe(false);
  });

  it("Adeptchads top 'A White Hole?': each player takes the top discard card (anticlockwise)", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("idol", "MJG-008"))));
    sess.state = M.replace(sess.state, {
      discard: ["d0", "d1", "d2"],
      instances: { ...sess.state.instances, d0: mk("d0", "MJG-011"), d1: mk("d1", "MJG-012"), d2: mk("d2", "MJG-013") },
    });
    sess.command(0, { do: "activate", iid: "idol", role: "top" });
    expect(M.player(sess.state, 0).hand).toContain("d0"); // controller first
    expect(M.player(sess.state, 1).hand).toContain("d1"); // next anticlockwise
    expect(sess.state.discard).toEqual(["d2"]); // one card left
  });

  it("Adeptchads bottom 'A Black Hole?': each owner discards their own cards one at a time", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("idol", "MJG-008"));
        p("board", 0, mk("a", "MJG-011"));
        p("board", 1, mk("b", "MJG-012"));
        p("board", 1, mk("fd", "", { faceDown: true })); // face-down survives
      }),
    );
    sess.command(0, { do: "activate", iid: "idol", role: "bottom" });
    expect(sess.state.phase).toBe(M.Phase.FORCED_DISCARD); // not a pre-pick; one-at-a-time
    // turn player (seat 0) discards their two face-up cards in their chosen order
    expect(sess.viewFor(0).legal.filter((x) => x.kind === "discard").map((x: any) => x.iid).sort()).toEqual(["a", "idol"]);
    sess.command(0, { do: "discard", iid: "a" });
    sess.command(0, { do: "discard", iid: "idol" });
    // then the opponent (seat 1) discards theirs — off-turn but allowed
    sess.command(1, { do: "discard", iid: "b" });
    expect(M.player(sess.state, 0).board).toEqual([]); // idol + a discarded (incl. itself)
    expect(M.player(sess.state, 1).board).toEqual(["fd"]); // only the face-down remains
    expect(sess.state.discard).toEqual(expect.arrayContaining(["idol", "a", "b"]));
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE); // back to the turn player's main phase
  });

  it("a declared meld opens a response window with its materials visible to all", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("m1", "", { value: 1 }));
        p("board", 0, mk("m2", "", { value: 1 }));
        p("board", 0, mk("m3", "", { value: 1 }));
        p("hand", 1, mk("ban", "MJG-013")); // a response holds the declaration window open
      }),
    );
    sess.setToggle(1, "auto");
    sess.command(0, { do: "meld", materials: ["m1", "m2", "m3"] });
    expect(sess.awaiting).toBe(1); // declaration window paused for the opponent
    const pm = sess.viewFor(1).pending.meld;
    expect(pm?.player).toBe(0);
    expect(pm?.cards.map((c) => c.iid).sort()).toEqual(["m1", "m2", "m3"]); // materials revealed
    expect(M.player(sess.state, 0).meldZone.length).toBe(0); // not resolved yet
    sess.respond(1, { pass: true });
    expect(M.player(sess.state, 0).meldZone.length).toBe(1); // resolves once the window closes
    expect(M.player(sess.state, 0).board).toEqual([]); // materials left the board
  });

  it("Koko Doko top 'Koko!': each opponent SS's a random hand card, then you draw per opponent", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("koko", "FAT-009"));
        p("hand", 1, mk("o1")); // opaque, no triggers
        p("hand", 1, mk("o2"));
      }),
    );
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "summon", iid: "koko" });
    expect(M.player(sess.state, 0).board).toContain("koko");
    expect(M.player(sess.state, 1).board.length).toBe(1); // opponent special-summoned a random card
    expect(M.player(sess.state, 1).hand.length).toBe(1); // one left
    expect(sess.state.mainDeck.length).toBe(deck0 - 1); // controller drew 1 (one opponent)
  });

  it("Koko Doko top: a random Brick is revealed, not summoned, and reduces the draw", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("koko", "FAT-009"));
        p("hand", 1, mk("brick", "MJG-C16")); // The Brick — opponent's only hand card
      }),
    );
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "summon", iid: "koko" });
    expect(M.player(sess.state, 1).board.length).toBe(0); // brick not summoned
    expect(M.player(sess.state, 1).hand).toContain("brick"); // stays in hand
    expect(sess.state.mainDeck.length).toBe(deck0); // controller drew 0 (one less)
    expect(sess.state.log.some((l) => l.includes("MJG-C16"))).toBe(true); // revealed in the log
  });

  it("Koko Doko bottom 'So Unlucky': top 3 forming a meld -> special meld", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("koko", "FAT-009"))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, t0: mk("t0", "", { value: 5 }), t1: mk("t1", "", { value: 5 }), t2: mk("t2", "", { value: 5 }) },
      mainDeck: ["t0", "t1", "t2", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "koko", role: "bottom" });
    const mz = M.player(sess.state, 0).meldZone;
    expect(mz.length).toBe(1);
    expect([...mz[0]!.cards].sort()).toEqual(["t0", "t1", "t2"]);
    expect(sess.state.mainDeck.slice(0, 3)).not.toContain("t0"); // consumed off the top
  });

  it("Koko Doko bottom: top 3 not a meld -> shuffled back, no meld", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("koko", "FAT-009"))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, t0: mk("t0", "", { value: 1 }), t1: mk("t1", "", { value: 3 }), t2: mk("t2", "", { value: 5 }) },
      mainDeck: ["t0", "t1", "t2", ...sess.state.mainDeck],
    });
    const deckLen = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "koko", role: "bottom" });
    expect(M.player(sess.state, 0).meldZone.length).toBe(0); // no meld made
    expect(sess.state.mainDeck.length).toBe(deckLen); // same cards, shuffled back
    expect(sess.state.mainDeck).toEqual(expect.arrayContaining(["t0", "t1", "t2"]));
  });

  it("an effect-made meld reaching 4 wins the game", () => {
    const dummy = { cards: ["x"], kind: "triplet" as const, kan: false };
    const sess = new GameSession(setup((p) => p("board", 0, mk("koko", "FAT-009"))));
    sess.state = M.replace(sess.state, {
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, meldZone: [dummy, dummy, dummy] } : p)),
      instances: { ...sess.state.instances, t0: mk("t0", "", { value: 5 }), t1: mk("t1", "", { value: 5 }), t2: mk("t2", "", { value: 5 }) },
      mainDeck: ["t0", "t1", "t2", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "koko", role: "bottom" });
    expect(sess.state.winner).toBe(0);
  });

  it("Literally Who? top 'Mahjong Crimes?': SS-able only after a battle discard this turn", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("hana", "MJG-012"));
        p("board", 0, mk("att", "", { atk: 5, def: 5 }));
        p("board", 1, mk("def", "", { atk: 1, def: 1 }));
      }),
    );
    const has = () => sess.viewFor(0).legal.some((a) => a.kind === "activate" && (a as any).iid === "hana");
    expect(has()).toBe(false); // no battle yet
    sess.command(0, { do: "attack", attacker: "att", target: "def" }); // def is battle-discarded
    expect(has()).toBe(true);
    sess.command(0, { do: "activate", iid: "hana", role: "top" });
    expect(M.player(sess.state, 0).board).toContain("hana");
  });

  it("Literally Who? bottom 'Watson': correct VALUE guess banishes the random card + draw", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("hana", "MJG-012"));
        p("hand", 1, mk("x", "", { value: 5 })); // opponent's only hand card -> the random pick
      }),
    );
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "hana", role: "bottom", targets: ["1"] });
    expect(sess.viewFor(0).choice?.numberInput).toEqual({ min: 1, max: 9 }); // activator guesses
    sess.choose(0, { use: true, value: 5 }); // correct
    expect(sess.state.banish).toContain("x");
    expect(M.player(sess.state, 1).hand).not.toContain("x");
    expect(sess.state.mainDeck.length).toBe(deck0 - 1); // drew 1
  });

  it("Watson: a wrong guess banishes nothing and the card stays hidden in hand", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("hana", "MJG-012"));
        p("hand", 1, mk("x", "", { value: 5 }));
      }),
    );
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "hana", role: "bottom", targets: ["1"] });
    sess.choose(0, { use: true, value: 3 }); // wrong
    expect(sess.state.banish).not.toContain("x");
    expect(M.player(sess.state, 1).hand).toContain("x");
    expect(sess.state.mainDeck.length).toBe(deck0); // no draw
    // the picked card + guess are public even on a wrong guess
    expect(sess.state.log.some((l) => l.includes("guessed VALUE 3") && l.includes("x"))).toBe(true);
  });

  it("Watson: for a star card, its OWNER chooses the value (and can dodge the guess)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("hana", "MJG-012"));
        p("hand", 1, mk("star", "", { value: null })); // ☆ value
      }),
    );
    sess.command(0, { do: "activate", iid: "hana", role: "bottom", targets: ["1"] });
    sess.choose(0, { use: true, value: 5 }); // activator guesses 5
    // the star card's owner (seat 1) now picks its value — and sees the guess (5)
    expect(sess.viewFor(1).choice?.numberInput).toEqual({ min: 1, max: 9 });
    expect(sess.viewFor(1).choice?.prompt).toContain("5");
    sess.choose(1, { use: true, value: 7 }); // owner dodges -> not 5
    expect(sess.state.banish).not.toContain("star"); // survives
  });

  it("Good Morning Sirs! top: opponent redeems -> card to their hand + you draw 2", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("sara", "MJG-015"))));
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "sara", role: "top", targets: ["1"] });
    expect(sess.viewFor(1).choice?.prompt).toContain("Redeem"); // the OPPONENT decides
    sess.choose(1, { use: true }); // redeem
    expect(M.player(sess.state, 1).hand).toContain("sara"); // added to their hand
    expect(M.player(sess.state, 0).board).not.toContain("sara");
    expect(sess.state.mainDeck.length).toBe(deck0 - 2); // controller drew 2
  });

  it("Good Morning Sirs! bottom 'Belly Dance': uses a controlled character's input-free Active", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("sara", "MJG-015"));
        p("board", 0, mk("ny", "MJG-001")); // Nyagger: bottom Active = summon top of deck
      }),
    );
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, top: mk("top", "MJG-011") }, mainDeck: ["top", ...sess.state.mainDeck] });
    sess.command(0, { do: "activate", iid: "sara", role: "bottom", targets: ["ny"] });
    expect(M.player(sess.state, 0).board).toContain("top"); // Nyagger's Active summoned the deck top
  });

  it("Belly Dance copying Haitei Raoyue runs the reveal+draw (logged with value), then the meld option", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("sara", "MJG-015"));
        p("board", 0, mk("koro", "MJG-C03", { atk: 1, def: 3, value: 5 }));
        p("board", 0, mk("b2", "", { value: 2 }));
        p("board", 0, mk("b3", "", { value: 3 }));
      }),
    );
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, d1: mk("d1", "MJG-011", { value: 1 }) },
      mainDeck: [...sess.state.mainDeck, "d1"], // bottom of the deck
    });
    sess.command(0, { do: "activate", iid: "sara", role: "bottom", targets: ["koro"] }); // copy Haitei
    // the copied pre-colon ran: revealed + drawn + logged with the VALUE
    expect(M.player(sess.state, 0).hand).toContain("d1");
    expect(sess.state.log.some((l) => l.includes("reveals and draws") && l.includes("MJG-011 (1)"))).toBe(true);
    // and the meld option continues as usual
    sess.choose(0, { use: true });
    sess.choose(0, { use: true, target: "b2" });
    sess.choose(0, { use: true, target: "b3" });
    expect(M.player(sess.state, 0).meldZone.length).toBe(1);
    expect([...M.player(sess.state, 0).meldZone[0]!.cards].sort()).toEqual(["b2", "b3", "d1"]);
  });

  it("Belly Dance copies a hand-meld Active (>dama): pick 3 hand cards -> special meld", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("sara", "MJG-015"));
        p("board", 0, mk("hag", "MJG-002")); // only Active is >dama (handMeld)
        p("hand", 0, mk("h1", "", { value: 3 }));
        p("hand", 0, mk("h2", "", { value: 3 }));
        p("hand", 0, mk("h3", "", { value: 3 })); // a valid triplet
      }),
    );
    const act = sess.viewFor(0).legal.find((a: any) => a.kind === "activate" && a.iid === "sara" && a.role === "bottom") as any;
    expect(act?.targetIds ?? []).toContain("hag"); // now a valid Belly Dance target
    sess.command(0, { do: "activate", iid: "sara", role: "bottom", targets: ["hag"] });
    expect(sess.viewFor(0).choice?.handMeld).toBe(true); // pick the hand meld
    sess.choose(0, { use: true, materials: ["h1", "h2", "h3"] });
    expect(M.player(sess.state, 0).meldZone.length).toBe(1); // special meld made from hand
    expect(M.player(sess.state, 0).hand).not.toContain("h1");
  });

  it("Belly Dance: a character with two Actives prompts which one to copy (by name)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("sara", "MJG-015"));
        p("board", 0, mk("idol", "MJG-008")); // Adeptchads: top AND bottom are Actives
        p("board", 0, mk("v", "", { value: 1 })); // a face-up card for A Black Hole to discard
      }),
    );
    sess.command(0, { do: "activate", iid: "sara", role: "bottom", targets: ["idol"] });
    const ch = sess.viewFor(0).choice;
    expect(ch?.options.map((o) => o.iid).sort()).toEqual(["bottom", "top"]); // choose which Active
    expect(ch?.options.map((o) => o.label).sort()).toEqual(["A Black Hole?", "A White Hole?"]);
    sess.choose(0, { use: true, target: "bottom" }); // copy "A Black Hole?" (forced discard of face-ups)
    expect(sess.state.phase).toBe(M.Phase.FORCED_DISCARD); // the copied Active ran
  });

  it("Belly Dance copies a target-requiring Active (Watson), gathering its input at resolution", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("sara", "MJG-015"));
        p("board", 0, mk("hana", "MJG-012")); // Literally Who?: bottom Active = Watson (opponent target + value guess)
        p("hand", 1, mk("x", "", { value: 5 })); // opponent's only hand card
      }),
    );
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "sara", role: "bottom", targets: ["hana"] });
    // Belly Dance gathers Watson's opponent target...
    sess.choose(0, { use: true, target: "1" });
    // ...then Watson's own value guess (resolution choice of the copied Active)
    expect(sess.viewFor(0).choice?.numberInput).toEqual({ min: 1, max: 9 });
    sess.choose(0, { use: true, value: 5 }); // correct
    expect(sess.state.banish).toContain("x"); // banished by the copied Watson
    expect(sess.state.mainDeck.length).toBe(deck0 - 1); // its draw 1
  });

  it("Good Morning Sirs! top: opponent declines -> you Special Summon it", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("sara", "MJG-015"))));
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "sara", role: "top", targets: ["1"] });
    sess.choose(1, { use: false }); // decline
    expect(M.player(sess.state, 0).board).toContain("sara"); // special-summoned to controller
    expect(M.player(sess.state, 1).hand).not.toContain("sara");
    expect(sess.state.mainDeck.length).toBe(deck0); // no draw
  });

  it("Banana top 'Ehe…': drawing it offers an immediate Special Summon", () => {
    let st = M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 0, cardRegistry: baseSet });
    st = M.replace(st, { instances: { ...st.instances, ban: mk("ban", "MJG-013") }, mainDeck: ["ban", ...st.mainDeck] });
    const sess = new GameSession(st);
    sess.command(0, { do: "draw" }); // draws Banana for turn
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-013:top"); // optional "when drawn" trigger
    sess.choose(0, { use: true });
    expect(M.player(sess.state, 0).board).toContain("ban"); // special-summoned
    expect(M.player(sess.state, 0).hand).not.toContain("ban");
  });

  it("Banana 'Ehe…' also triggers from the opening hand (before the first turn draw)", () => {
    const st = M.newGame({ players: [0, 1], mainDeck: ["MJG-013", "MJG-011", "MJG-011", "MJG-011"], startingHand: 1, cardRegistry: baseSet });
    const sess = new GameSession(st);
    sess.begin();
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-013:top"); // opened with Banana -> prompted
    sess.choose(0, { use: true });
    expect(M.player(sess.state, 0).board.some((iid) => sess.state.instances[iid]?.cardId === "MJG-013")).toBe(true);
  });

  it("MJG-M12 'fOUnD mEeEeee' does NOT chain to opponents' opening-hand draws (only from the first turn draw on)", () => {
    // deal (anticlockwise from p0): p0 gets deck[0],deck[2]; p1 gets deck[1]=MJG-M12,deck[3]
    const st = M.newGame({ players: [0, 1], mainDeck: ["MJG-011", "MJG-M12", "MJG-011", "MJG-011"], startingHand: 2, cardRegistry: baseSet });
    const sess = new GameSession(st);
    sess.begin();
    expect(M.player(sess.state, 1).hand.some((iid) => sess.state.instances[iid]?.cardId === "MJG-M12")).toBe(true); // p1 holds the hand-trap
    expect(sess.viewFor(1).choice?.effectId).not.toBe("MJG-M12:top"); // not prompted by p0's opening deal
    expect(sess.state.chain.length).toBe(0); // nothing chained off the starting hand
  });

  it("Banana bottom 'RAKII': melding it offers drawing 2", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("ban", "MJG-013", { value: 2 }));
        p("board", 0, mk("m1", "", { value: 2 }));
        p("board", 0, mk("m2", "", { value: 2 }));
      }),
    );
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "meld", materials: ["ban", "m1", "m2"] });
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-013:bottom"); // "if melded" trigger
    sess.choose(0, { use: true });
    expect(sess.state.mainDeck.length).toBe(deck0 - 2); // drew 2
  });

  it("an attack auto-resolves through the declaration window (defender discarded)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 5, def: 2, tapped: false }));
        p("board", 1, mk("def", "", { atk: 1, def: 1 }));
      }),
    );
    const r = sess.command(0, { do: "attack", attacker: "att", target: "def" });
    expect(r.ok).toBe(true);
    expect(sess.awaiting).toBeNull();
    expect(M.player(sess.state, 1).board).not.toContain("def"); // discarded by battle
    expect(M.inst(sess.state, "att").tapped).toBe(true); // attacker taps
  });

  it("rejects an illegal attack target", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("att", "", { atk: 5 }))));
    const r = sess.command(0, { do: "attack", attacker: "att", target: "nope" });
    expect(r.ok).toBe(false);
  });

  it("summon triggers auto-process (Ice Princess discards VALUE<=4)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("kagy", "MJG-C15", { atk: 1, def: 5, value: 5 }));
        p("board", 0, mk("lo", "", { value: 3 }));
        p("board", 1, mk("hi", "", { value: 7 }));
      }),
    );
    sess.command(0, { do: "summon", iid: "kagy" });
    expect(sess.awaiting).toBeNull();
    expect(M.player(sess.state, 0).board).toContain("kagy");
    expect(M.player(sess.state, 0).board).not.toContain("lo");
    expect(M.player(sess.state, 1).board).toContain("hi");
  });
});

describe("priority orchestration — auto toggle (prompt only when can respond)", () => {
  function twoPlayer() {
    const s = setup((p) => {
      p("hand", 0, mk("v", "MJG-011")); // active player's summon material
      p("hand", 1, mk("yz", "MJG-013")); // opponent's (At any time) responder (Banana)
    });
    return new GameSession(s);
  }

  it("prompts the auto opponent who has a legal response", () => {
    const sess = twoPlayer();
    sess.setToggle(1, "auto");
    sess.command(0, { do: "summon", iid: "v" });
    expect(sess.awaiting).toBe(1); // paused for the opponent to respond
  });

  it("opponent passes -> the window resolves", () => {
    const sess = twoPlayer();
    sess.setToggle(1, "auto");
    sess.command(0, { do: "summon", iid: "v" });
    const r = sess.respond(1, { pass: true });
    expect(r.ok).toBe(true);
    expect(sess.awaiting).toBeNull();
    expect(M.player(sess.state, 0).board).toContain("v");
    expect(M.player(sess.state, 1).board).not.toContain("yz");
  });

  it("opponent responds -> their effect resolves on the chain", () => {
    const sess = twoPlayer();
    sess.setToggle(1, "auto");
    sess.command(0, { do: "summon", iid: "v" });
    sess.respond(1, { activate: { iid: "yz", role: "top" } });
    expect(sess.awaiting).toBeNull();
    expect(M.player(sess.state, 1).board).toContain("yz"); // YUZU summoned via response
    expect(M.player(sess.state, 0).board).toContain("v");
  });

  it("the actor may respond to their own action (Fix A: keeps priority first; needs 'always')", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("v", "MJG-011")); // a summon
        p("hand", 0, mk("own", "MJG-013")); // the turn player's own (At any time) effect
      }),
    );
    sess.setToggle(0, "always"); // responding to your OWN action is an "always"-only prompt
    sess.command(0, { do: "summon", iid: "v" });
    expect(sess.awaiting).toBe(0); // turn player is prompted to respond to their own summon
  });

  it("off opponent is NOT prompted even with a legal response", () => {
    const sess = twoPlayer(); // toggles default off
    sess.command(0, { do: "summon", iid: "v" });
    expect(sess.awaiting).toBeNull();
    expect(M.player(sess.state, 0).board).toContain("v");
  });

  it("auto opponent with NO legal response is NOT prompted", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("v", "MJG-011")))); // opp hand empty
    sess.setToggle(1, "auto");
    sess.command(0, { do: "summon", iid: "v" });
    expect(sess.awaiting).toBeNull();
  });
});

describe("strict PSCT — step-wise resolution + activation-time decisions", () => {
  it("MJG-77* (Correction): a response window opens between the Special Summon (and-joined) and the banish (then)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("kavi", "MJG-77*"));
        p("board", 1, mk("weak", "", { atk: 1, def: 1 })); // 1 DEF -> targetable
        p("hand", 1, mk("yz", "MJG-029")); // an at-any-time card so player 1 has a real response
      }),
    );
    sess.setToggle(1, "always"); // prompted at every open window WITH a response
    sess.command(0, { do: "activate", iid: "kavi", role: "top", targets: ["weak"] });
    expect(sess.awaiting).toBe(1); // activation window
    sess.respond(1, { pass: true });
    // target+SS are `and`-joined (one step): the SS has resolved, the banish has NOT,
    // and a response window is open between them (the `then`).
    expect(M.player(sess.state, 0).board).toContain("kavi");
    expect(sess.state.banish).not.toContain("weak");
    expect(sess.awaiting).toBe(1); // inter-step window before the banish
    sess.respond(1, { pass: true });
    expect(sess.state.banish).toContain("weak"); // banished once the window closes
  });

  it("FAT-009 (Koko Doko): a response window opens before the draw (`Next`)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("koko", "FAT-009"));
        p("hand", 0, mk("yz", "MJG-029")); // controller's at-any-time response (not summoned — FAT hits opponents)
        p("hand", 1, mk("o1")); // opponent's single summonable card
      }),
    );
    sess.setToggle(0, "always"); // turn player prompted at its own open windows
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "summon", iid: "koko" });
    // pass any windows up to and including the trigger's activation window, until step 0
    // (all opponents SS a random card) has resolved.
    for (let g = 0; g < 5 && sess.awaiting === 0 && !M.player(sess.state, 1).board.includes("o1"); g++) sess.respond(0, { pass: true });
    expect(M.player(sess.state, 1).board).toContain("o1"); // step 0 done
    expect(sess.state.mainDeck.length).toBe(deck0); // the draw step is gated behind a window
    expect(sess.awaiting).toBe(0); // window before the draw (`Next`)
    sess.respond(0, { pass: true });
    expect(sess.state.mainDeck.length).toBe(deck0 - 1); // drew 1 (one card summoned)
  });

  it("MJG-012 (Watson): the random pick + VALUE guess are an activation condition (no response window during it)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("hana", "MJG-012"));
        p("hand", 1, mk("x", "", { value: 5 })); // opponent's only hand card (so the random pick is deterministic)
      }),
    );
    sess.setToggle(1, "always"); // even "always" gets no window during the activation condition
    sess.command(0, { do: "activate", iid: "hana", role: "bottom", targets: ["1"] });
    // the controller is prompted to guess BEFORE the link is chained; no opponent window yet.
    expect(sess.viewFor(0).choice?.numberInput).toEqual({ min: 1, max: 9 });
    expect(sess.awaiting).toBeNull();
    sess.choose(0, { use: true, value: 5 }); // correct
    expect(sess.state.banish).toContain("x"); // the post-colon effect banishes the guessed card
  });

  it("MJG-015 (iTunes Gift Card): the targeted opponent's redeem decision is made at activation", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("sara", "MJG-015"))));
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "sara", role: "top", targets: ["1"] });
    expect(sess.viewFor(1).choice?.prompt).toMatch(/[Rr]edeem/); // the TARGET decides, at activation
    expect(sess.awaiting).toBeNull();
    sess.choose(1, { use: true }); // redeem -> sara to their hand, controller draws 2
    expect(M.player(sess.state, 1).hand).toContain("sara");
    expect(sess.state.mainDeck.length).toBe(deck0 - 2);
  });
});

describe("MJG-018 Rigged Hands", () => {
  it("top 'Typical Haipai': accepting shuffles the hand into the deck and draws the same number", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("momo", "MJG-018"));
        p("hand", 0, mk("h1"));
        p("hand", 0, mk("h2"));
      }),
    );
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "summon", iid: "momo" });
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-018:top"); // optional trigger prompts
    const hand0 = M.player(sess.state, 0).hand.length; // h1, h2 + the turn draw
    sess.choose(0, { use: true });
    const me = M.player(sess.state, 0);
    expect(me.hand.length).toBe(hand0); // drew back the same number
    expect(sess.state.mainDeck.length).toBe(deck0); // +N shuffled in, -N drawn
    // the shuffled-in cards are in the deck (or were drawn back) — not lost
    for (const iid of ["h1", "h2"]) expect([...sess.state.mainDeck, ...me.hand]).toContain(iid);
  });

  it("top: declining leaves the hand untouched", () => {
    const sess = new GameSession(setup((p) => { p("hand", 0, mk("momo", "MJG-018")); p("hand", 0, mk("h1")); }));
    sess.command(0, { do: "summon", iid: "momo" });
    const hand0 = [...M.player(sess.state, 0).hand];
    sess.choose(0, { use: false });
    expect(M.player(sess.state, 0).hand).toEqual(hand0); // untouched
  });

  it("bottom 'Mr Rabbit': returns the targeted character to its OWNER's hand and taps the source", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("momo", "MJG-018"));
        p("board", 1, mk("vic", "", { atk: 3, def: 3 }));
      }),
    );
    sess.command(0, { do: "activate", iid: "momo", role: "bottom", targets: ["vic"] });
    expect(M.player(sess.state, 1).hand).toContain("vic"); // back to the OWNER's hand
    expect(M.player(sess.state, 1).board).not.toContain("vic");
    expect(sess.state.instances["momo"]?.tapped).toBe(true); // using an Active taps it
  });
});

describe("MJG-021 Justice for Lalatano", () => {
  it("top: chains to a draw effect — SS this; inter-step window; negate that effect and discard that card", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("chio", "MJG-003")); // Koromo Janai zo! = a draw Active
        p("hand", 1, mk("lala", "MJG-021"));
        p("hand", 1, mk("yz", "MJG-029")); // a second anytime card so the inter-step window is observable
      }),
    );
    sess.setToggle(1, "always");
    const hand0 = M.player(sess.state, 0).hand.length;
    sess.command(0, { do: "activate", iid: "chio", role: "bottom" });
    expect(sess.awaiting).toBe(1); // a draw effect was activated -> Lalatano is offered
    sess.respond(1, { activate: { iid: "lala", role: "top" } });
    expect(sess.awaiting).toBe(1); // response window to Lalatano's own activation
    sess.respond(1, { pass: true });
    // step 0 (SS this card) resolved; the negate is gated behind the `then` window
    expect(M.player(sess.state, 1).board).toContain("lala");
    expect(sess.state.discard).not.toContain("chio"); // not negated/discarded yet
    expect(sess.awaiting).toBe(1); // inter-step window (yz is a valid response)
    sess.respond(1, { pass: true });
    // step 1: negate the draw effect + discard its card; the negated link fizzles
    expect(sess.state.discard).toContain("chio");
    expect(M.player(sess.state, 0).board).not.toContain("chio");
    expect(M.player(sess.state, 0).hand.length).toBe(hand0); // the draw never happened
    expect(sess.state.log.some((l) => l.includes("negated"))).toBe(true);
  });

  it("top: NOT offered against a non-draw activation ('adding to hand is not drawing')", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("momo", "MJG-018")); // Mr Rabbit: bounce — adds to hand, doesn't draw
        p("board", 0, mk("vic", "", { atk: 2, def: 2 }));
        p("hand", 1, mk("lala", "MJG-021"));
      }),
    );
    sess.setToggle(1, "always");
    sess.command(0, { do: "activate", iid: "momo", role: "bottom", targets: ["vic"] });
    expect(sess.awaiting).toBeNull(); // no draw effect on the chain -> Lalatano not offered
    expect(M.player(sess.state, 0).hand).toContain("vic"); // the bounce resolved
  });

  it("bottom 'Hitsuji ga Ippiki': the draw grows by 1 each use while in play", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("lala", "MJG-021"))));
    const hand0 = M.player(sess.state, 0).hand.length;
    sess.command(0, { do: "activate", iid: "lala", role: "bottom" });
    expect(M.player(sess.state, 0).hand.length).toBe(hand0 + 1); // first use: draw 1
    expect(sess.state.instances["lala"]?.counters["sheep"]).toBe(1);
    // untap and use it again: now draws 2
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, lala: { ...sess.state.instances["lala"]!, tapped: false } } });
    sess.command(0, { do: "activate", iid: "lala", role: "bottom" });
    expect(M.player(sess.state, 0).hand.length).toBe(hand0 + 3); // +2 more
    expect(sess.state.instances["lala"]?.counters["sheep"]).toBe(2);
  });
});

describe("MJG-32歳 Mommy Milkers", () => {
  it("bottom 'From the Source': doubles ANOTHER character's ATK/DEF (cannot target itself)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("momy", "MJG-32歳", { atk: 8, def: 8, value: 8 }));
        p("board", 1, mk("vic", "", { atk: 2, def: 3 }));
      }),
    );
    const act = sess.viewFor(0).legal.find((a: any) => a.kind === "activate" && a.iid === "momy" && a.role === "bottom") as any;
    expect(act?.targetIds).toContain("vic");
    expect(act?.targetIds).not.toContain("momy"); // "another character"
    sess.command(0, { do: "activate", iid: "momy", role: "bottom", targets: ["vic"] });
    expect(M.atkOf(sess.state, "vic")).toBe(4); // doubled until end of turn
    expect(M.defOf(sess.state, "vic")).toBe(6);
  });

  it("top 'Milked' protection: an effect can't bounce it off the board (targetable, no effect — R16)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("momo", "MJG-018")); // Mr Rabbit (bounce)
        p("board", 1, mk("momy", "MJG-32歳", { atk: 8, def: 8, value: 8 }));
      }),
    );
    sess.command(0, { do: "activate", iid: "momo", role: "bottom", targets: ["momy"] });
    expect(M.player(sess.state, 1).board).toContain("momy"); // still on the board
    expect(M.player(sess.state, 1).hand).not.toContain("momy");
    expect(sess.state.log.some((l) => l.includes("cannot be removed"))).toBe(true);
  });

  it("top protection: survives an Adeptchads board wipe (exempt from the forced discards)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("idol", "MJG-008"));
        p("board", 1, mk("momy", "MJG-32歳", { atk: 8, def: 8, value: 8 }));
        p("board", 1, mk("b", "", { atk: 1, def: 1 }));
      }),
    );
    sess.command(0, { do: "activate", iid: "idol", role: "bottom" });
    sess.command(0, { do: "discard", iid: "idol" }); // turn player discards their own card
    sess.command(1, { do: "discard", iid: "b" }); // opponent's only NON-protected card
    expect(M.player(sess.state, 1).board).toEqual(["momy"]); // momy was never queued
    expect(sess.state.discard).toEqual(expect.arrayContaining(["idol", "b"]));
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE);
  });
});

describe("BAK-YOU Friendly Only Bnuuy", () => {
  it("top 'Watapon': drawing it BY AN EFFECT offers a Special Summon", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("lala", "MJG-021")))); // Hitsuji = an effect draw
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, bn: mk("bn", "BAK-YOU") },
      mainDeck: ["bn", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "lala", role: "bottom" }); // draws bn by effect
    expect(sess.viewFor(0).choice?.effectId).toBe("BAK-YOU:top"); // Watapon prompts
    sess.choose(0, { use: true });
    expect(M.player(sess.state, 0).board).toContain("bn"); // special-summoned
    // ...and the SS itself triggers Book of Moon (lala is a candidate) — decline it
    expect(sess.viewFor(0).choice?.effectId).toBe("BAK-YOU:bottom");
    sess.choose(0, { use: false });
  });

  it("top: the TURN draw does NOT offer it (a game action, not a card effect)", () => {
    let st = M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 0, cardRegistry: baseSet });
    st = M.replace(st, { instances: { ...st.instances, bn: mk("bn", "BAK-YOU") }, mainDeck: ["bn", ...st.mainDeck] });
    const sess = new GameSession(st);
    sess.command(0, { do: "draw" }); // the turn draw
    expect(M.player(sess.state, 0).hand).toContain("bn");
    expect(sess.viewFor(0).choice).toBeNull(); // no Watapon prompt
  });

  it("bottom 'Book of Moon': flips another character face-down until the start of YOUR next turn", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("bn", "BAK-YOU"));
        p("board", 1, mk("vic", "", { atk: 3, def: 3 }));
      }),
    );
    sess.command(0, { do: "summon", iid: "bn" });
    const choice = sess.viewFor(0).choice;
    expect(choice?.effectId).toBe("BAK-YOU:bottom");
    expect(choice?.options.map((o) => o.iid)).toContain("vic");
    expect(choice?.options.map((o) => o.iid)).not.toContain("bn"); // "another character"
    sess.choose(0, { use: true, target: "vic" });
    expect(sess.state.instances["vic"]?.faceDown).toBe(true);
    // the OPPONENT's turn starting doesn't unflip it (it's the controller's "your")
    sess.state = M.reduce(M.replace(sess.state, { phase: M.Phase.TURN_END }), { type: M.ActionType.ADVANCE });
    expect(sess.state.instances["vic"]?.faceDown).toBe(true);
    // the controller's next turn starts: flips back face-up
    sess.state = M.reduce(M.replace(sess.state, { phase: M.Phase.TURN_END }), { type: M.ActionType.ADVANCE });
    expect(sess.state.instances["vic"]?.faceDown).toBe(false);
    // ...and as the START of the new turn, not the end of the old one: the flip-up
    // is logged AFTER the turn advance
    const lines = sess.state.log;
    const advanceAt = lines.findIndex((l) => l.includes("advance -> player 0"));
    const unflipAt = lines.findIndex((l) => l.includes("flips face-up"));
    expect(advanceAt).toBeGreaterThanOrEqual(0);
    expect(unflipAt).toBeGreaterThan(advanceAt);
  });

  it("bottom: Mommy Milkers cannot be flipped face-down (ruling)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("bn", "BAK-YOU"));
        p("board", 1, mk("momy", "MJG-32歳", { atk: 8, def: 8, value: 8 }));
      }),
    );
    sess.command(0, { do: "summon", iid: "bn" });
    sess.choose(0, { use: true, target: "momy" }); // targetable (R16) — the flip fizzles
    expect(sess.state.instances["momy"]?.faceDown).toBe(false);
    expect(sess.state.log.some((l) => l.includes("cannot be flipped"))).toBe(true);
  });
});

describe("MJG-020 G***u", () => {
  it("top 'Copestream': battle-discarding it makes its owner skip their next turn", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 5, def: 5 }));
        p("board", 1, mk("gyaru", "MJG-020", { atk: 2, def: 0, value: 2 }));
      }),
    );
    sess.command(0, { do: "attack", attacker: "att", target: "gyaru" });
    expect(sess.state.discard).toContain("gyaru"); // lost the battle
    expect(sess.state.pendingSkips).toContain(1); // mandatory Copestream resolved
    // ending p0's turn skips p1 entirely — the next turn is p0's again
    sess.state = M.reduce(M.replace(sess.state, { phase: M.Phase.TURN_END }), { type: M.ActionType.ADVANCE });
    expect(sess.state.activePlayer).toBe(0);
    expect(sess.state.log.some((l) => l.includes("skipped"))).toBe(true);
    expect(sess.state.pendingSkips).toEqual([]); // the debt is consumed
  });

  it("bottom 'Fatherless Behaviour': wrong guess costs the target a discard; correct doesn't; repeat is optional", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("gyaru", "MJG-020", { atk: 2, def: 0, value: 2 }));
        p("hand", 0, mk("odd5", "", { value: 5 }));
        p("hand", 0, mk("even4", "", { value: 4 }));
        p("hand", 1, mk("x"));
        p("hand", 1, mk("y"));
      }),
    );
    sess.command(0, { do: "activate", iid: "gyaru", role: "bottom", targets: ["1"] });
    // round 1: the controller picks privately via the hand-pick UI (Reveal button)
    expect(sess.viewFor(0).choice?.prompt).toMatch(/Round 1/);
    expect(sess.viewFor(0).choice?.handPick).toBe("reveal");
    sess.choose(0, { use: true, target: "odd5" });
    expect(sess.viewFor(1).choice?.prompt).toMatch(/parity/);
    sess.choose(1, { use: true, target: "even" }); // wrong — 5 is odd
    // the guess REVEALS the chosen card publicly (logged with its value)
    expect(sess.state.log.some((l) => l.includes("odd5") && l.includes("VALUE 5") && l.includes("wrong"))).toBe(true);
    // the loser's discard uses the hand-pick UI (click a hand card -> Discard button)
    expect(sess.viewFor(1).choice?.handPick).toBe("discard");
    sess.choose(1, { use: true, target: "x" }); // so they discard one of their choice
    expect(sess.state.discard).toContain("x");
    sess.choose(0, { use: true }); // repeat -> round 2
    sess.choose(0, { use: true, target: "even4" });
    sess.choose(1, { use: true, target: "even" }); // correct — no discard
    expect(M.player(sess.state, 1).hand).toContain("y");
    sess.choose(0, { use: false }); // stop after 2 of 3 rounds
    expect(sess.viewFor(0).choice).toBeNull();
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE);
    expect(sess.state.instances["gyaru"]?.tapped).toBe(true); // using the Active taps
  });

  it("bottom: ☆ counts as even", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("gyaru", "MJG-020", { atk: 2, def: 0, value: 2 }));
        p("hand", 0, mk("star", "", { value: null }));
        p("hand", 1, mk("x"));
      }),
    );
    sess.command(0, { do: "activate", iid: "gyaru", role: "bottom", targets: ["1"] });
    sess.choose(0, { use: true, target: "star" });
    sess.choose(1, { use: true, target: "even" }); // ☆ is even -> correct
    expect(M.player(sess.state, 1).hand).toContain("x"); // no discard
    sess.choose(0, { use: false });
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE);
  });
});

describe("MJG-022 GOTH (Call of Mastema)", () => {
  it("bottom: banish a chosen hand card (hand-click UI); then (window) draw 1", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("goth", "MJG-022", { atk: 1, def: 5, value: 9 }));
        p("hand", 0, mk("fodder", "", { value: 3 }));
        p("hand", 1, mk("yz", "MJG-029")); // an at-any-time response so the inter-step window is observable
      }),
    );
    sess.setToggle(1, "always");
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "goth", role: "bottom" });
    expect(sess.awaiting).toBe(1); // activation window first
    sess.respond(1, { pass: true });
    // the pick is the controller's, rendered as hand-pick with a Banish button
    const ch = sess.viewFor(0).choice;
    expect(ch?.handPick).toBe("banish");
    expect(ch?.prompt).toMatch(/banish 1 card/);
    sess.choose(0, { use: true, target: "fodder" });
    // step 0 (banish) resolved; the draw is gated behind the `then` window
    expect(sess.state.banish).toContain("fodder");
    expect(sess.state.mainDeck.length).toBe(deck0); // not drawn yet
    expect(sess.awaiting).toBe(1); // inter-step window
    sess.respond(1, { pass: true });
    expect(sess.state.mainDeck.length).toBe(deck0 - 1); // then draw 1
  });

  it("bottom: not offered with an empty hand", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("goth", "MJG-022", { atk: 1, def: 5, value: 9 }))));
    // empty the hand (setup's turn draw gave one card)
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: [] } : p)) });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "goth" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-888 Gweilo!", () => {
  it("top 'Frustrated?': the discard cost is paid at activation; then look at their hand and take 1", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("fuji", "MJG-888", { atk: 3, def: 1, value: 3 }));
        p("hand", 0, mk("a"));
        p("hand", 0, mk("b"));
        p("hand", 1, mk("x", "MJG-011"));
        p("hand", 1, mk("y", "MJG-013"));
      }),
    );
    sess.command(0, { do: "activate", iid: "fuji", role: "top", targets: ["1"] });
    // pre-colon cost: pick 2 OTHER hand cards via the hand-pick UI (self excluded)
    let ch = sess.viewFor(0).choice;
    expect(ch?.handPick).toBe("discard");
    expect(ch?.options.map((o) => o.iid)).not.toContain("fuji");
    sess.choose(0, { use: true, target: "a" });
    sess.choose(0, { use: true, target: "b" });
    // the cost (this + 2) is in the discard before the effect resolves
    expect(sess.state.discard).toEqual(expect.arrayContaining(["fuji", "a", "b"]));
    // resolution: the controller sees the TARGET's hand and takes 1 — private to them
    ch = sess.viewFor(0).choice;
    expect(ch?.options.map((o) => o.iid).sort()).toEqual(["x", "y"]);
    expect(sess.viewFor(1).choice).toBeNull();
    sess.choose(0, { use: true, target: "x" });
    expect(M.player(sess.state, 0).hand).toContain("x");
    expect(M.player(sess.state, 1).hand).not.toContain("x");
  });

  it("top: not offered without this + 2 other hand cards", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("fuji", "MJG-888"))));
    // hand = fuji + the turn draw = 2 cards -> can't pay the cost
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "fuji")).toBe(false);
  });

  it("bottom 'Buy Jade': draws 1 from the Faith deck; not offered when it's empty", () => {
    let st = M.newGame({ players: [0, 1], mainDeck: 20, faithDeck: 5, startingHand: 0, cardRegistry: baseSet });
    st = M.reduce(st, { type: M.ActionType.DRAW_RESOLVES });
    st = M.replace(st, { instances: { ...st.instances, fuji: mk("fuji", "MJG-888") } });
    st = M.replace(st, { players: st.players.map((p) => (p.pid === 0 ? { ...p, board: [...p.board, "fuji"] } : p)) });
    const sess = new GameSession(st);
    const f0 = sess.state.faithDeck.length;
    const h0 = M.player(sess.state, 0).hand.length;
    sess.command(0, { do: "activate", iid: "fuji", role: "bottom" });
    expect(sess.state.faithDeck.length).toBe(f0 - 1);
    expect(M.player(sess.state, 0).hand.length).toBe(h0 + 1);
    // empty Faith deck (untap first) -> no longer offered
    sess.state = M.replace(sess.state, { faithDeck: [], instances: { ...sess.state.instances, fuji: { ...sess.state.instances["fuji"]!, tapped: false } } });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "fuji" && a.role === "bottom")).toBe(false);
  });
});

describe("KSG-EMI Hotwheels", () => {
  it("top 'Break a Leg': SS by overlaying onto an opponent's character — their board, character beneath", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("emi", "KSG-EMI", { atk: 0, def: 5, value: 5 }));
        p("board", 1, mk("vic", "", { atk: 2, def: 2 }));
      }),
    );
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "emi") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetIds).toEqual(["vic"]); // only OPPONENT characters
    sess.command(0, { do: "activate", iid: "emi", role: "top", targets: ["vic"] });
    expect(M.player(sess.state, 1).board).toContain("emi"); // lands on the OPPONENT's board
    expect(M.player(sess.state, 1).board).not.toContain("vic"); // tucked beneath it
    expect(M.player(sess.state, 0).board).not.toContain("emi");
    expect(sess.state.instances["emi"]?.overlays).toEqual(["vic"]);
    // the overlay materials are public — the viewer shows them
    const bv = sess.viewFor(0).players.find((p) => p.pid === 1)!.board.find((c) => c.iid === "emi")!;
    expect(bv.overlays).toBe(1);
    expect(bv.overlaid?.map((c) => c.iid)).toEqual(["vic"]);
  });

  it("bottom 'Trolley Problem': at the controller's turn end it rolls to the shimocha with a chosen passenger", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("emi", "KSG-EMI", { atk: 0, def: 5, value: 5 }));
        p("board", 0, mk("tag", "", { atk: 1, def: 1 }));
      }),
    );
    sess.command(0, { do: "endTurn" });
    const ch = sess.viewFor(0).choice; // mandatory trigger; the controller picks the passenger
    expect(ch?.options.map((o) => o.iid)).toEqual(["tag"]); // "one OTHER character" — not itself
    sess.choose(0, { use: true, target: "tag" });
    expect(M.player(sess.state, 1).board).toEqual(expect.arrayContaining(["emi", "tag"]));
    expect(M.player(sess.state, 0).board).toEqual([]);
  });

  it("bottom: with no other character it rolls alone", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("emi", "KSG-EMI", { atk: 0, def: 5, value: 5 }))));
    sess.command(0, { do: "endTurn" });
    expect(sess.viewFor(0).choice).toBeNull(); // "(if any)" -> no prompt
    expect(M.player(sess.state, 1).board).toContain("emi");
  });

  it("discarding Hotwheels takes the overlaid character to the discard with it", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("emi", "KSG-EMI", { atk: 0, def: 5, value: 5 }));
        p("board", 1, mk("vic", "", { atk: 2, def: 2 }));
        p("board", 0, mk("att", "", { atk: 9, def: 9 }));
      }),
    );
    sess.command(0, { do: "activate", iid: "emi", role: "top", targets: ["vic"] });
    sess.command(0, { do: "attack", attacker: "att", target: "emi" }); // 9 ATK > 5 DEF
    expect(sess.state.discard).toEqual(expect.arrayContaining(["emi", "vic"]));
  });
});

describe("MJG-026 Bravo", () => {
  it("top 'Fake News': chains to an opponent's ACTIVE — discard this; window; negate + discard that card", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("chio", "MJG-003")); // an ACTIVE (Koromo Janai zo!)
        p("hand", 1, mk("bravo", "MJG-026", { atk: 2, def: 4, value: 6 }));
      }),
    );
    sess.setToggle(1, "auto");
    const hand0 = M.player(sess.state, 0).hand.length;
    sess.command(0, { do: "activate", iid: "chio", role: "bottom" });
    expect(sess.awaiting).toBe(1); // an opponent SPELL/ACTIVE activation -> Bravo offered
    sess.respond(1, { activate: { iid: "bravo", role: "top" } });
    // step 0: Bravo discards ITSELF (its cost-step); the negate is behind the `then`
    expect(sess.state.discard).toContain("bravo");
    // (no other responders -> the window auto-passes and step 1 resolves)
    expect(sess.state.discard).toContain("chio"); // negated card discarded
    expect(M.player(sess.state, 0).hand.length).toBe(hand0); // the draw never happened
    expect(sess.state.log.some((l) => l.includes("negated"))).toBe(true);
  });

  it("top: NOT offered against your own activation, nor against a triggered PASSIVE", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 1, mk("chio", "MJG-003"));
        p("hand", 1, mk("bravo", "MJG-026", { atk: 2, def: 4, value: 6 }));
      }),
    );
    sess.setToggle(1, "always");
    sess.state = M.replace(sess.state, { activePlayer: 1 });
    sess.command(1, { do: "activate", iid: "chio", role: "bottom" }); // YOUR OWN activation
    expect(sess.awaiting).toBeNull(); // Bravo not offered (sourcePlayer === seat)
  });

  it("bottom 'Big if True': reveals until two VALUE-4+ (public), adds them, shuffles back", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("bravo", "MJG-026", { atk: 2, def: 4, value: 6 }))));
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances,
        v2: mk("v2", "", { value: 2 }), star: mk("star", "", { value: null }),
        v5: mk("v5", "MJG-011", { value: 5 }), v1: mk("v1", "", { value: 1 }), v6: mk("v6", "MJG-013", { value: 6 }),
      },
      mainDeck: ["v2", "star", "v5", "v1", "v6", ...sess.state.mainDeck],
    });
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "bravo", role: "bottom" });
    const me = M.player(sess.state, 0);
    expect(me.hand).toEqual(expect.arrayContaining(["v5", "v6"])); // the two hits
    expect(me.hand).not.toContain("star"); // ☆ has no VALUE — not a hit
    expect(sess.state.mainDeck.length).toBe(deck0 - 2); // rest shuffled back
    expect(sess.state.mainDeck).toEqual(expect.arrayContaining(["v2", "star", "v1"]));
    // the revealed cards are logged WITH their VALUEs (in brackets; ☆ for no value)
    expect(sess.state.log.some((l) => l.includes("reveals from the deck") && l.includes("MJG-011 (5)") && l.includes("MJG-013 (6)") && l.includes("(☆)"))).toBe(true);
  });

  it("bottom: a deck with fewer than two hits adds what it found", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("bravo", "MJG-026", { atk: 2, def: 4, value: 6 }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, a: mk("a", "", { value: 1 }), b: mk("b", "", { value: 7 }), c: mk("c", "", { value: 2 }) },
      mainDeck: ["a", "b", "c"], // only one hit in the whole deck
    });
    sess.command(0, { do: "activate", iid: "bravo", role: "bottom" });
    expect(M.player(sess.state, 0).hand).toContain("b");
    expect([...sess.state.mainDeck].sort()).toEqual(["a", "c"]);
  });
});

describe("MJG-028 Fujoshi Doujinshi", () => {
  it("top 'BL': offered only with 2+ MALE characters on boards; SS then draw 2", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("onod", "MJG-028", { atk: 2, def: 5, value: 3 }));
        p("board", 0, mk("m1", "MJG-M07")); // El Primer Furry (gender M)
        p("board", 1, mk("f1", "MJG-011")); // female — doesn't count
      }),
    );
    // 1 male -> not offered
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "onod")).toBe(false);
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, m2: mk("m2", "MJG-C16") }, // The Brick (gender M)
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, board: [...p.board, "m2"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "onod")).toBe(true); // 2 males (any boards)
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "onod", role: "top" });
    expect(M.player(sess.state, 0).board).toContain("onod"); // SS'd
    expect(sess.state.mainDeck.length).toBe(deck0 - 2); // then drew 2
  });

  it("bottom 'Right-to-Left': the deck physically flips while it's on a board, and flips back when it leaves", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("onod", "MJG-028", { atk: 2, def: 5, value: 3 }));
        p("board", 1, mk("att", "", { atk: 9, def: 9 }));
      }),
    );
    // a REAL card on the physical bottom — it becomes the visible top when flipped
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, real: mk("real", "MJG-011") },
      mainDeck: [...sess.state.mainDeck, "real"],
    });
    const before = [...sess.state.mainDeck];
    sess.command(0, { do: "summon", iid: "onod" });
    expect(sess.state.deckFlipped).toBe(true);
    expect([...sess.state.mainDeck]).toEqual([...before].reverse()); // the pile is flipped over
    expect(sess.state.log.some((l) => l.includes("upside-down"))).toBe(true);
    // an upside-down deck shows its top card face-out, to everyone
    expect(sess.viewFor(0).deckTop?.iid).toBe("real");
    expect(sess.viewFor(1).deckTop?.iid).toBe("real");
    expect(sess.viewFor(1).deckTop?.cardId).toBe("MJG-011"); // identity visible
    // drawing now takes the former BOTTOM card (the physical top)
    const formerBottom = before[before.length - 1];
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" });
    expect(M.player(sess.state, 1).hand).toContain(formerBottom);
    // battle-discard it on p1's turn -> the deck flips back over
    sess.command(1, { do: "attack", attacker: "att", target: "onod" });
    expect(sess.state.discard).toContain("onod");
    expect(sess.state.deckFlipped).toBe(false);
    expect(sess.state.log.some((l) => l.includes("flips back over"))).toBe(true);
    expect(sess.viewFor(0).deckTop).toBeNull(); // face-down again
  });
});

describe("JONG-030 I want /vt/ to leave", () => {
  it("top 'Exploiting Lonely Men': only opponents with NO FEMALE characters are targetable", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("neet", "JONG-030", { atk: 3, def: 0, value: 3 }));
        p("board", 1, mk("f1", "MJG-011")); // Haruna — gender F
      }),
    );
    // p1 controls a FEMALE character -> no valid opponent -> not offered at all
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "neet")).toBe(false);
    // remove her -> offered, with p1 enumerated as a valid seat
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, board: [] } : p)) });
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "neet") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetSeats).toEqual([1]);
  });

  it("top: SS; window; they draw 1; and-then they GIVE a chosen hand card (the drawn one is givable)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("neet", "JONG-030", { atk: 3, def: 0, value: 3 }));
        p("hand", 1, mk("keep"));
      }),
    );
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, fresh: mk("fresh", "MJG-011") },
      mainDeck: ["fresh", ...sess.state.mainDeck], // p1 will draw this
    });
    sess.command(0, { do: "activate", iid: "neet", role: "top", targets: ["1"] });
    expect(M.player(sess.state, 0).board).toContain("neet"); // SS'd
    // after their draw, the TARGET picks the card to give (hand-pick "Give" button)
    const ch = sess.viewFor(1).choice;
    expect(ch?.handPick).toBe("give");
    expect(ch?.options.map((o) => o.iid)).toContain("fresh"); // the just-drawn card counts
    sess.choose(1, { use: true, target: "fresh" });
    expect(M.player(sess.state, 0).hand).toContain("fresh"); // given to the activator
    expect(M.player(sess.state, 1).hand).toContain("keep");
  });

  it("bottom 'Simp': the target privately picks >=1 of the deck top 3 for the activator; the rest keep their order", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("neet", "JONG-030", { atk: 3, def: 0, value: 3 }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, t0: mk("t0", "MJG-011"), t1: mk("t1", "MJG-013"), t2: mk("t2", "MJG-018") },
      mainDeck: ["t0", "t1", "t2", ...sess.state.mainDeck],
    });
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "neet", role: "bottom", targets: ["1"] });
    // the TARGET (p1) sees the top 3 — the activator does not
    expect(sess.viewFor(1).choice?.options.map((o) => o.iid).sort()).toEqual(["t0", "t1", "t2"]);
    expect(sess.viewFor(0).choice).toBeNull();
    sess.choose(1, { use: true, target: "t1" }); // mandatory first give
    sess.choose(1, { use: true }); // give another? yes
    sess.choose(1, { use: true, target: "t0" });
    sess.choose(1, { use: false }); // stop at two
    expect(M.player(sess.state, 0).hand).toEqual(expect.arrayContaining(["t0", "t1"]));
    expect(sess.state.mainDeck[0]).toBe("t2"); // the unpicked card stays on top, same order
    expect(sess.state.mainDeck.length).toBe(deck0 - 2);
  });
});

describe("MJG-031 Chuuni-Sister-Daughter-Wife", () => {
  const onlyCrafted = (sess: GameSession, keep: string[]) => {
    sess.state = M.replace(sess.state, {
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: p.hand.filter((h) => keep.includes(h)) } : p)),
    });
  };

  it("bottom 'Onii-chan?': SS a hand card with more ATK, DEF, and VALUE — only qualifying cards offered", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("imou", "MJG-031", { atk: 1, def: 1, value: 2 }));
        p("hand", 0, mk("big", "", { atk: 2, def: 2, value: 3 })); // strictly more on all three
        p("hand", 0, mk("meh", "", { atk: 2, def: 2, value: 2 })); // VALUE not more
      }),
    );
    onlyCrafted(sess, ["big", "meh"]); // drop the turn-draw card (could qualify)
    sess.command(0, { do: "activate", iid: "imou", role: "bottom" });
    const ch = sess.viewFor(0).choice;
    expect(ch?.handPick).toBe("summon"); // hand-pick UI with a Summon button
    expect(ch?.options.map((o) => o.iid)).toEqual(["big"]); // 'meh' filtered out
    sess.choose(0, { use: true, target: "big" });
    expect(M.player(sess.state, 0).board).toContain("big"); // special-summoned
    expect(M.player(sess.state, 0).hand).not.toContain("big");
  });

  it("bottom: gated on a qualifying card existing — and stat CHANGES are counted", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("imou", "MJG-031", { atk: 1, def: 1, value: 2 }));
        p("hand", 0, mk("meh", "", { atk: 2, def: 2, value: 2 })); // ties imou's VALUE
      }),
    );
    onlyCrafted(sess, ["meh"]);
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "imou" && a.role === "bottom")).toBe(false);
    // lower imou's effective VALUE by a stat mod -> 'meh' now strictly exceeds all three
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, imou: { ...sess.state.instances["imou"]!, mods: [{ stat: "value", op: "add", amount: -1, duration: "persistent" }] } },
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "imou" && a.role === "bottom")).toBe(true);
  });
});

describe("MJG-333 Ninpo! Triplets no Jutsu!", () => {
  it("top 'Ninjutsu': needs a NON-KAN triplet; SS; window; draw 3; shuffle 3 picked cards back", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("ninj", "MJG-333", { atk: 3, def: 3, value: 3 }))));
    // no triplet meld -> not offered
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "ninj")).toBe(false);
    // a KAN'd triplet doesn't count
    sess.state = M.replace(sess.state, {
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, meldZone: [{ cards: ["x1", "x2", "x3", "x4"], kind: "triplet" as const, kan: true }] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "ninj")).toBe(false);
    // a real triplet does
    sess.state = M.replace(sess.state, {
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, meldZone: [{ cards: ["x1", "x2", "x3"], kind: "triplet" as const, kan: false }] } : p)),
    });
    sess.command(0, { do: "activate", iid: "ninj", role: "top" });
    expect(M.player(sess.state, 0).board).toContain("ninj"); // SS'd
    // drew 3; now pick 3 to shuffle back, one at a time (hand-pick "Shuffle in")
    const deckAfterDraw = sess.state.mainDeck.length;
    const hand = [...M.player(sess.state, 0).hand];
    expect(sess.viewFor(0).choice?.handPick).toBe("shuffle");
    sess.choose(0, { use: true, target: hand[0]! });
    sess.choose(0, { use: true, target: hand[1]! });
    sess.choose(0, { use: true, target: hand[2]! });
    expect(M.player(sess.state, 0).hand.length).toBe(hand.length - 3);
    expect(sess.state.mainDeck.length).toBe(deckAfterDraw + 3); // shuffled back in
  });

  it("bottom 'Shadow Clone': the clone's effects are negated, and it dies when the summoner leaves", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("ninj", "MJG-333", { atk: 3, def: 3, value: 3 }));
        p("hand", 0, mk("clone", "MJG-003")); // Cheese Chotto — normally has a summon trigger + an Active
        p("board", 1, mk("att", "", { atk: 9, def: 9 }));
      }),
    );
    sess.command(0, { do: "activate", iid: "ninj", role: "bottom" });
    expect(sess.viewFor(0).choice?.handPick).toBe("summon");
    sess.choose(0, { use: true, target: "clone" });
    expect(M.player(sess.state, 0).board).toContain("clone");
    expect(sess.state.instances["clone"]?.effectsNegated).toBe(true);
    // its summon trigger didn't fire (no prompt pending) and its Active is not offered
    expect(sess.viewFor(0).choice).toBeNull();
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "clone")).toBe(false);
    // the summoner leaves the board (battle) -> the clone is discarded with it
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" });
    sess.command(1, { do: "attack", attacker: "att", target: "ninj" }); // 9 ATK > 3 DEF
    expect(sess.state.discard).toEqual(expect.arrayContaining(["ninj", "clone"]));
    expect(M.player(sess.state, 0).board).not.toContain("clone");
  });
});

describe("MJG-035 Take your meds", () => {
  it("top 'Antipsychotics': every [Schizo] is effect-negated (from anywhere) and 0/0 on board", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 1, mk("nurse", "MJG-035", { atk: 1, def: 4, value: 4 }));
        p("board", 0, mk("schb", "MJG-002", { atk: 2, def: 3, value: 2, tribes: ["Schizo"] }));
        p("hand", 0, mk("miki", "MJG-002", { tribes: ["Schizo"] })); // Look at this Hag! — a hand spell
      }),
    );
    expect(M.atkOf(sess.state, "schb")).toBe(0); // reduced to 0/0 on board
    expect(M.defOf(sess.state, "schb")).toBe(0);
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "miki")).toBe(false); // negated from the HAND too
    // the nurse leaves -> stats and activations restore
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, board: [] } : p)) });
    expect(M.atkOf(sess.state, "schb")).toBe(2);
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "miki")).toBe(true);
  });

  it("bottom 'Immunize': the target can't be melded or effect-removed until the start of your next turn", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("nurse", "MJG-035", { atk: 1, def: 4, value: 4 }));
        p("board", 0, mk("ward", "", { atk: 1, def: 1, value: 5 }));
        p("board", 0, mk("m2", "", { value: 5 }));
        p("board", 0, mk("m3", "", { value: 5 }));
        p("board", 1, mk("momo", "MJG-018")); // Mr Rabbit (a bounce effect)
      }),
    );
    sess.command(0, { do: "activate", iid: "nurse", role: "bottom", targets: ["ward"] });
    expect(sess.state.instances["ward"]?.protectedFromEffects).toBe(true);
    // melding with the immunized card is rejected (it would be a 5-5-5 triplet)
    expect(sess.command(0, { do: "meld", materials: ["ward", "m2", "m3"] }).ok).toBe(false);
    // an opponent's bounce fizzles on it
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" });
    sess.command(1, { do: "activate", iid: "momo", role: "bottom", targets: ["ward"] });
    expect(M.player(sess.state, 0).board).toContain("ward"); // still on the board
    // the protection lapses at the start of the GRANTER's next turn
    sess.command(1, { do: "endTurn" });
    sess.command(1, { do: "advance" });
    expect(sess.state.instances["ward"]?.protectedFromEffects).toBe(false);
    expect(sess.state.log.some((l) => l.includes("no longer immunized"))).toBe(true);
  });
});

describe("MJG-037 AI(Steve)", () => {
  it("top 'AI Apocalypse': vs a bigger board, the battle counterpart's DEF is 0 — during the battle only", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("steve", "MJG-037", { atk: 7, def: 3, value: 5 }));
        p("board", 1, mk("wall", "", { atk: 1, def: 8 })); // survives 7 ATK normally
        p("board", 1, mk("extra", "", { atk: 1, def: 1 })); // p1 out-boards p0 (2 vs 1)
      }),
    );
    expect(M.defOf(sess.state, "wall")).toBe(8); // outside a battle, DEF is untouched
    sess.command(0, { do: "attack", attacker: "steve", target: "wall" });
    expect(sess.state.discard).toContain("wall"); // its DEF was 0 during the battle
  });

  it("top: no reduction when the opponent does NOT have more board cards", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("steve", "MJG-037", { atk: 7, def: 3, value: 5 }));
        p("board", 1, mk("wall", "", { atk: 1, def: 8 })); // boards are 1 vs 1
      }),
    );
    sess.command(0, { do: "attack", attacker: "steve", target: "wall" });
    expect(M.player(sess.state, 1).board).toContain("wall"); // survived: 7 < 8
  });

  it("top: another attacker doesn't benefit — scoped to battles with THIS card", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("steve", "MJG-037", { atk: 7, def: 3, value: 5 }));
        p("board", 0, mk("ally", "", { atk: 7, def: 1 }));
        p("board", 1, mk("wall", "", { atk: 1, def: 8 }));
        p("board", 1, mk("e1", "", { atk: 1, def: 1 }));
        p("board", 1, mk("e2", "", { atk: 1, def: 1 })); // 3 vs 2 — bigger board
      }),
    );
    sess.command(0, { do: "attack", attacker: "ally", target: "wall" });
    expect(M.player(sess.state, 1).board).toContain("wall"); // no apocalypse for the ally
  });
});

describe("MJG-0w0 BIG FLAT CAT TATS", () => {
  it("top 'Stwengths in Nwumbwehs': +1/+1 per OTHER Furry on any board", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("cat", "MJG-0w0", { atk: 3, def: 3, value: 1, tribes: ["Furry"] }));
        p("board", 1, mk("f1", "", { atk: 1, def: 1, tribes: ["Furry"] }));
        p("board", 1, mk("plain", "", { atk: 1, def: 1 }));
      }),
    );
    expect(M.atkOf(sess.state, "cat")).toBe(4); // 3 + 1 other Furry (any board)
    expect(M.defOf(sess.state, "cat")).toBe(4);
  });

  it("bottom '*glomp*': draw 1 per Furry on any board (itself included)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("cat", "MJG-0w0", { atk: 3, def: 3, value: 1, tribes: ["Furry"] }));
        p("board", 1, mk("f1", "", { atk: 1, def: 1, tribes: ["Furry"] }));
        p("board", 1, mk("fd", "", { tribes: ["Furry"], faceDown: true })); // hidden — doesn't count
        p("board", 0, mk("plain", "", { atk: 1, def: 1 }));
      }),
    );
    const hand0 = M.player(sess.state, 0).hand.length;
    sess.command(0, { do: "activate", iid: "cat", role: "bottom" });
    expect(M.player(sess.state, 0).hand.length).toBe(hand0 + 2); // cat + f1; the face-down Furry hidden
    expect(sess.state.instances["cat"]?.tapped).toBe(true);
  });
});

describe("MJG-039 Ravioli Ravioli", () => {
  it("top 'succ' + bottom 'Omurice!': attach, grow +1/+1/+1, repeat with the GROWN value", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("rav", "MJG-039", { atk: 1, def: 1, value: 1 }));
        p("board", 1, mk("v1", "", { atk: 1, def: 1, value: 1 }));
        p("board", 1, mk("v2", "", { atk: 2, def: 2, value: 2 })); // reachable only AFTER growing
      }),
    );
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "rav") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetIds).toEqual(["v1"]); // VALUE 2 > 1 -> v2 not initially legal
    sess.command(0, { do: "activate", iid: "rav", role: "top", targets: ["v1"] });
    // v1 attached: Omurice grants +1/+1/+1 live
    expect(sess.state.instances["rav"]?.overlays).toEqual(["v1"]);
    expect(M.atkOf(sess.state, "rav")).toBe(2);
    expect(M.valueOf(sess.state, "rav")).toBe(2);
    sess.choose(0, { use: true }); // attach another?
    expect(sess.viewFor(0).choice?.options.map((o) => o.iid)).toEqual(["v2"]); // now in range
    sess.choose(0, { use: true, target: "v2" });
    expect(sess.state.instances["rav"]?.overlays).toEqual(["v1", "v2"]);
    expect(M.valueOf(sess.state, "rav")).toBe(3);
    expect(sess.viewFor(0).choice).toBeNull(); // no targets left -> the loop ended itself
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE);
  });

  it("bottom: at 8 overlaid cards it discards them and becomes a completed meld", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("rav", "MJG-039", { atk: 1, def: 1, value: 1 }));
        p("board", 1, mk("v1", "", { atk: 1, def: 1, value: 1 }));
        p("hand", 0, mk("ninja", "MJG-333", { atk: 3, def: 3, value: 3 })); // needs a non-KAN TRIPLET
      }),
    );
    const ovs = Array.from({ length: 7 }, (_, i) => `ov${i}`);
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances,
        ...Object.fromEntries(ovs.map((o) => [o, mk(o)])),
        rav: { ...sess.state.instances["rav"]!, overlays: ovs },
      },
    });
    sess.command(0, { do: "activate", iid: "rav", role: "top", targets: ["v1"] }); // the 8th card
    expect(M.player(sess.state, 0).board).not.toContain("rav"); // converted
    const meld = M.player(sess.state, 0).meldZone.find((m) => m.cards.includes("rav"));
    expect(meld?.kind).toBe("single"); // a one-card meld — NEITHER a triplet nor a sequence
    expect(sess.state.discard).toEqual(expect.arrayContaining([...ovs, "v1"])); // all 8 discarded
    expect(sess.state.log.some((l) => l.includes("completed meld"))).toBe(true);
    // triplet-gated things don't apply to it: no KAN, and Ninjutsu isn't enabled by it
    const mi = M.player(sess.state, 0).meldZone.findIndex((m) => m.cards.includes("rav"));
    expect(() => M.reduce(sess.state, { type: M.ActionType.RESOLVE_KAN, player: 0, meldIndex: mi, kanMaterial: "ninja" })).toThrow(/triplet/);
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "ninja" && a.role === "top")).toBe(false);
  });
});

describe("MJG-041 p*n*s (Supermodel)", () => {
  it("alone on the board: survives a losing battle and shrugs off effects (incl. stat changes)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("model", "MJG-041", { atk: 3, def: 2, value: 6 }));
        p("board", 1, mk("att", "", { atk: 9, def: 9 }));
        p("board", 1, mk("momo", "MJG-018")); // Mr Rabbit (bounce)
        p("board", 1, mk("momy", "MJG-32歳", { atk: 8, def: 8, value: 8 })); // From the Source (statMod)
      }),
    );
    // an opponent's bounce fizzles
    sess.state = M.replace(sess.state, { activePlayer: 1 });
    sess.command(1, { do: "activate", iid: "momo", role: "bottom", targets: ["model"] });
    expect(M.player(sess.state, 0).board).toContain("model");
    // a stat-doubling effect does nothing
    sess.command(1, { do: "activate", iid: "momy", role: "bottom", targets: ["model"] });
    expect(M.atkOf(sess.state, "model")).toBe(3); // unchanged
    expect(sess.state.log.some((l) => l.includes("immune to card effects"))).toBe(true);
    // a losing battle doesn't discard it
    sess.command(1, { do: "attack", attacker: "att", target: "model" }); // 9 ATK > 2 DEF
    expect(M.player(sess.state, 0).board).toContain("model"); // still standing
    expect(sess.state.log.some((l) => l.includes("cannot be discarded by battle"))).toBe(true);
  });

  it("with a second card on the board, the protection is off", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("model", "MJG-041", { atk: 3, def: 2, value: 6 }));
        p("board", 0, mk("friend", "", { atk: 1, def: 1 })); // no longer alone
        p("board", 1, mk("att", "", { atk: 9, def: 9 }));
      }),
    );
    sess.state = M.replace(sess.state, { activePlayer: 1 });
    sess.command(1, { do: "attack", attacker: "att", target: "model" });
    expect(sess.state.discard).toContain("model"); // dies normally
  });
});

describe("MJG-043 YJK", () => {
  it("top 'Animal Tamer': a [Furry] meld counts as a Special Meld — the normal meld stays available", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("yjk", "MJG-043", { atk: 1, def: 1, value: 3 }));
        p("board", 0, mk("fur", "", { value: 5, tribes: ["Furry"] }));
        p("board", 0, mk("a", "", { value: 5 }));
        p("board", 0, mk("b", "", { value: 5 }));
        p("board", 0, mk("c", "", { value: 7 }));
        p("board", 0, mk("d", "", { value: 7 }));
        p("board", 0, mk("e", "", { value: 7 }));
      }),
    );
    expect(sess.command(0, { do: "meld", materials: ["fur", "a", "b"] }).ok).toBe(true);
    expect(M.player(sess.state, 0).meldedThisTurn).toBe(false); // counted as SPECIAL
    expect(sess.state.log.some((l) => l.includes("Animal Tamer"))).toBe(true);
    // the once-per-turn normal meld is still available afterwards
    expect(sess.command(0, { do: "meld", materials: ["c", "d", "e"] }).ok).toBe(true);
    expect(M.player(sess.state, 0).meldedThisTurn).toBe(true); // consumed by the non-furry meld
  });

  it("top: after the normal meld, only [Furry] melds remain offered/legal", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("yjk", "MJG-043", { atk: 1, def: 1, value: 3 }));
        p("board", 0, mk("a", "", { value: 5 }));
        p("board", 0, mk("b", "", { value: 5 }));
        p("board", 0, mk("c", "", { value: 5 }));
        p("board", 0, mk("fur", "", { value: 7, tribes: ["Furry"] }));
        p("board", 0, mk("d", "", { value: 7 }));
        p("board", 0, mk("e", "", { value: 7 }));
        p("board", 0, mk("f", "", { value: 9 }));
        p("board", 0, mk("g", "", { value: 9 }));
        p("board", 0, mk("h", "", { value: 9 }));
      }),
    );
    expect(sess.command(0, { do: "meld", materials: ["a", "b", "c"] }).ok).toBe(true); // the normal meld
    expect(M.player(sess.state, 0).meldedThisTurn).toBe(true);
    expect(sess.command(0, { do: "meld", materials: ["f", "g", "h"] }).ok).toBe(false); // non-furry rejected
    expect(sess.viewFor(0).legal.some((x) => x.kind === "meld")).toBe(true); // still offered (furry combo exists)
    expect(sess.command(0, { do: "meld", materials: ["fur", "d", "e"] }).ok).toBe(true); // furry passes
  });

  it("bottom 'Mojito': SS a 3-ATK hand card — only those offered", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("yjk", "MJG-043", { atk: 1, def: 1, value: 3 }));
        p("hand", 0, mk("three", "", { atk: 3, def: 1 }));
        p("hand", 0, mk("four", "", { atk: 4, def: 1 }));
      }),
    );
    // drop the turn-draw card (a real card could happen to have 3 ATK)
    sess.state = M.replace(sess.state, {
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: p.hand.filter((h) => ["three", "four"].includes(h)) } : p)),
    });
    sess.command(0, { do: "activate", iid: "yjk", role: "bottom" });
    const ch = sess.viewFor(0).choice;
    expect(ch?.handPick).toBe("summon");
    expect(ch?.options.map((o) => o.iid)).toEqual(["three"]); // 4 ATK filtered out
    sess.choose(0, { use: true, target: "three" });
    expect(M.player(sess.state, 0).board).toContain("three");
  });
});

describe("MJG-044 Pon Yeehaw", () => {
  it("top 'Black or White': pick its VALUE; then opposite-parity characters are force-discarded", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("pon", "MJG-044", { atk: 1, def: 8, value: null }));
        p("board", 0, mk("odd1", "", { value: 3 }));
        p("board", 1, mk("even1", "", { value: 4 }));
        p("board", 1, mk("odd2", "", { value: 5 }));
        p("board", 1, mk("star", "", { value: null })); // ☆ — no parity, survives
      }),
    );
    sess.command(0, { do: "summon", iid: "pon" });
    expect(sess.viewFor(0).choice?.numberInput).toEqual({ min: 1, max: 999 }); // "any ℕ"
    sess.choose(0, { use: true, value: 4 }); // even
    expect(M.valueOf(sess.state, "pon")).toBe(4);
    expect(sess.state.log.some((l) => l.includes("Black or White") && l.includes("VALUE to 4"))).toBe(true); // the chosen VALUE is logged
    // the odd-VALUE characters queue as FAQ §9 forced discards, turn player first
    expect(sess.state.phase).toBe(M.Phase.FORCED_DISCARD);
    sess.command(0, { do: "discard", iid: "odd1" });
    sess.command(1, { do: "discard", iid: "odd2" });
    expect(sess.state.discard).toEqual(expect.arrayContaining(["odd1", "odd2"]));
    expect(M.player(sess.state, 1).board).toEqual(expect.arrayContaining(["even1", "star"])); // survivors
    expect(M.player(sess.state, 0).board).toContain("pon"); // its own parity matches itself
  });

  it("bottom 'We're not gay!': a same-parity attack discards neither and both owners draw 1", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("pon", "MJG-044", { atk: 1, def: 8, value: 3 }));
        p("board", 1, mk("odd", "", { atk: 9, def: 0, value: 5 })); // same parity; would normally TRADE
      }),
    );
    const h0 = M.player(sess.state, 0).hand.length;
    const h1 = M.player(sess.state, 1).hand.length;
    sess.command(0, { do: "attack", attacker: "pon", target: "odd" });
    expect(M.player(sess.state, 0).board).toContain("pon"); // neither is discarded
    expect(M.player(sess.state, 1).board).toContain("odd");
    expect(M.player(sess.state, 0).hand.length).toBe(h0 + 1); // both owners drew 1
    expect(M.player(sess.state, 1).hand.length).toBe(h1 + 1);
    expect(sess.state.log.some((l) => l.includes("not gay"))).toBe(true);
  });

  it("bottom: opposite parity -> a normal battle", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("pon", "MJG-044", { atk: 1, def: 8, value: 3 }));
        p("board", 1, mk("even", "", { atk: 1, def: 0, value: 4 }));
      }),
    );
    sess.command(0, { do: "attack", attacker: "pon", target: "even" });
    expect(sess.state.discard).toContain("even"); // 1 ATK > 0 DEF, no protection
  });
});

describe("targeting: a character flipped face-down mid-chain is no longer valid", () => {
  it("YUZU GRAPE's banish fizzles when Famous Fagat flips the target face-down first", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("grape", "MJG-77*")); // Correction: target a 1-DEF char, SS self, THEN banish it
        p("hand", 1, mk("fagat", "MJG-M13")); // Trap Trick: flip target face-down + SS self
        p("board", 1, mk("yuzu", "MJG-029")); // YUZU YUZU YUZU — 1/1/1, a valid (1 DEF) face-up target
      }),
    );
    sess.setToggle(1, "auto"); // P1 reacts to P0's activation
    sess.command(0, { do: "activate", iid: "grape", role: "top", targets: ["yuzu"] });
    expect(sess.awaiting).toBe(1); // P1 gets the response window
    sess.respond(1, { activate: { iid: "fagat", role: "top", targets: ["yuzu"] } });
    // Chain resolves LIFO: Famous Fagat flips YUZU face-down (+ SS), then YUZU GRAPE
    // SS's itself but its banish sees a now-face-down ("non-existing") target -> fizzles.
    expect(sess.state.instances["yuzu"]?.faceDown).toBe(true);
    expect(sess.state.banish).not.toContain("yuzu"); // NOT banished — the target went invalid
    expect(M.player(sess.state, 1).board).toContain("yuzu"); // still on P1's board
    expect(M.player(sess.state, 0).board).toContain("grape"); // YUZU GRAPE still summoned (non-target part resolves)
    expect(M.player(sess.state, 1).board).toContain("fagat"); // Famous Fagat summoned
  });
});

describe("MJG-045 Liyuean Opera", () => {
  it("top 'Ear Rape': on summon, all OTHER characters are stunned until their OWN owner's turn end", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("opera", "MJG-045", { atk: 2, def: 2, value: 5 }));
        p("board", 0, mk("mine", "MJG-003")); // has a board Active normally
        p("board", 1, mk("theirs", "", { atk: 5, def: 5 }));
      }),
    );
    sess.command(0, { do: "summon", iid: "opera" });
    expect(sess.state.instances["mine"]?.stunned).toBe(true);
    expect(sess.state.instances["theirs"]?.stunned).toBe(true);
    expect(sess.state.instances["opera"]?.stunned).toBeFalsy(); // "all OTHER"
    // a stunned card can neither attack nor use Actives
    expect(sess.viewFor(0).legal.some((a) => (a.kind === "attack" || a.kind === "activate") && a.iid === "mine")).toBe(false);
    // P0 ends their turn -> P0's card unstuns; the opponent's stays stunned...
    sess.command(0, { do: "endTurn" });
    expect(sess.state.instances["mine"]?.stunned).toBe(false);
    expect(sess.state.instances["theirs"]?.stunned).toBe(true);
    // ...through their whole turn (no attacking), until THEY end it
    sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" });
    expect(sess.viewFor(1).legal.some((a) => a.kind === "attack" && a.iid === "theirs")).toBe(false);
    sess.command(1, { do: "endTurn" });
    expect(sess.state.instances["theirs"]?.stunned).toBe(false);
  });

  it("bottom 'Lead Character': the chosen card COVERS it (arrives stunned); at your turn end it returns and Opera stays", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("opera", "MJG-045", { atk: 2, def: 2, value: 5 }));
        p("hand", 0, mk("lead", "MJG-011"));
      }),
    );
    sess.command(0, { do: "activate", iid: "opera", role: "bottom" });
    expect(sess.viewFor(0).choice?.handPick).toBe("overlay");
    sess.choose(0, { use: true, target: "lead" });
    // the chosen card is the stack TOP: it takes Opera's board slot, Opera tucks beneath
    expect(M.player(sess.state, 0).board).toContain("lead");
    expect(M.player(sess.state, 0).board).not.toContain("opera");
    expect(sess.state.instances["lead"]?.overlays).toContain("opera");
    expect(sess.state.instances["lead"]?.stunned).toBe(true); // the COVER is stunned
    expect(sess.state.instances["opera"]?.stunned).toBeFalsy(); // not Opera
    // it did not count as a summon (Ear Rape must not have fired on anything)
    expect(sess.state.chain.length).toBe(0);
    // at the end of your turn the cover returns to hand; Opera pops back onto the board
    sess.command(0, { do: "endTurn" });
    expect(M.player(sess.state, 0).hand).toContain("lead");
    expect(sess.state.instances["lead"]?.stunned).toBe(false); // left play -> state shed
    expect(M.player(sess.state, 0).board).toContain("opera");
    expect(M.player(sess.state, 0).board).not.toContain("lead");
    expect(sess.state.instances["opera"]?.overlays).toEqual([]);
  });

  it("bottom: a Brick is not a valid cover (excluded from the pick; not activatable off an all-Brick hand)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("opera", "MJG-045", { atk: 2, def: 2, value: 5 }));
        p("hand", 0, mk("brick", "MJG-C16", { atk: 9, def: 9, value: 9 }));
        p("hand", 0, mk("ok", "MJG-011"));
      }),
    );
    sess.command(0, { do: "activate", iid: "opera", role: "bottom" });
    const opts = (sess.viewFor(0).choice?.options ?? []).map((o) => o.iid);
    expect(opts).not.toContain("brick"); // the Brick is not offered
    expect(opts).toContain("ok");
    sess.choose(0, { use: true, target: "ok" });
    // with ONLY Bricks in hand, the Active isn't offered at all
    const sess2 = new GameSession(
      setup((p) => {
        p("board", 0, mk("opera", "MJG-045", { atk: 2, def: 2, value: 5 }));
        p("hand", 0, mk("brick", "MJG-C16", { atk: 9, def: 9, value: 9 }));
      }),
    );
    sess2.state = M.replace(sess2.state, { players: sess2.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["brick"] } : p)) });
    expect(sess2.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "opera" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-046 UNTZ UNTZ UNTZ UNTZ", () => {
  it("top 'Party Hard': on summon, all characters scatter to random boards (conserved; protected stay)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("untz", "MJG-046", { atk: 2, def: 2, value: 5 }));
        p("board", 0, mk("a", "", { atk: 1, def: 1 }));
        p("board", 0, mk("b", "", { atk: 1, def: 1 }));
        p("board", 1, mk("c", "", { atk: 1, def: 1 }));
        p("board", 1, mk("momy", "MJG-32歳", { atk: 8, def: 8, value: 8 })); // board-protected
      }),
    );
    sess.command(0, { do: "summon", iid: "untz" });
    const all = sess.state.players.flatMap((p) => [...p.board]);
    // every character (incl. UNTZ itself) is still on exactly one board
    expect([...all].sort()).toEqual(["a", "b", "c", "momy", "untz"].sort());
    expect(M.player(sess.state, 1).board).toContain("momy"); // protected: never moves
    expect(sess.state.log.some((l) => l.includes("party scatters"))).toBe(true);
  });

  it("bottom 'Deuteragonist': the chosen card COVERS it (UNTZ tucks beneath), then the scramble — the stack rides along", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("untz", "MJG-046", { atk: 2, def: 2, value: 5 }));
        p("hand", 0, mk("lead", "MJG-011"));
        p("board", 1, mk("c", "", { atk: 1, def: 1 }));
      }),
    );
    sess.command(0, { do: "activate", iid: "untz", role: "bottom" });
    expect(sess.viewFor(0).choice?.handPick).toBe("overlay");
    sess.choose(0, { use: true, target: "lead" });
    // the chosen card is the stack TOP: on a board (wherever the scramble put it), UNTZ beneath
    expect(M.player(sess.state, 0).hand).not.toContain("lead");
    expect(sess.state.players.some((p) => p.board.includes("lead"))).toBe(true);
    expect(sess.state.players.some((p) => p.board.includes("untz"))).toBe(false); // covered, not standalone
    expect(sess.state.instances["lead"]?.overlays).toContain("untz");
    expect(sess.state.instances["lead"]?.stunned).toBeFalsy(); // no stun clause on Deuteragonist
    // no end-of-turn return for this cover (unlike Lead Character)
    sess.command(0, { do: "endTurn" });
    expect(sess.state.instances["lead"]?.overlays).toContain("untz");
    expect(M.player(sess.state, 0).hand).not.toContain("lead");
  });

  it("bottom: a Brick is not a valid cover; all-Brick hand -> not activatable", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("untz", "MJG-046", { atk: 2, def: 2, value: 5 }));
        p("hand", 0, mk("brick", "MJG-C16", { atk: 9, def: 9, value: 9 }));
        p("hand", 0, mk("ok", "MJG-011"));
      }),
    );
    sess.command(0, { do: "activate", iid: "untz", role: "bottom" });
    const opts = (sess.viewFor(0).choice?.options ?? []).map((o) => o.iid);
    expect(opts).not.toContain("brick"); // the Brick is not offered
    expect(opts).toContain("ok");
    sess.choose(0, { use: true, target: "ok" });
    const sess2 = new GameSession(
      setup((p) => {
        p("board", 0, mk("untz", "MJG-046", { atk: 2, def: 2, value: 5 }));
        p("hand", 0, mk("brick", "MJG-C16", { atk: 9, def: 9, value: 9 }));
      }),
    );
    sess2.state = M.replace(sess2.state, { players: sess2.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["brick"] } : p)) });
    expect(sess2.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "untz" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-047 Jane4", () => {
  it("top 'Useless Censors': flip a face-down character face-up — repeatable, card stays in hand", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("jane", "MJG-047", { atk: 0, def: 6, value: 4 }));
        p("board", 1, mk("fd1", "MJG-011", { faceDown: true }));
        p("board", 1, mk("fd2", "MJG-013", { faceDown: true }));
        p("board", 1, mk("up", "", { atk: 1, def: 1 })); // face-up — NOT a valid target
      }),
    );
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "jane") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetIds?.sort()).toEqual(["fd1", "fd2"]); // only face-down characters
    sess.command(0, { do: "activate", iid: "jane", role: "top", targets: ["fd1"] });
    expect(sess.state.instances["fd1"]?.faceDown).toBe(false); // flipped face-up
    expect(M.player(sess.state, 0).hand).toContain("jane"); // revealed, not spent
    // repeatable: use it again right away on the second one
    expect(sess.command(0, { do: "activate", iid: "jane", role: "top", targets: ["fd2"] }).ok).toBe(true);
    expect(sess.state.instances["fd2"]?.faceDown).toBe(false);
    // with nothing face-down left, it's no longer offered
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "jane")).toBe(false);
  });

  it("bottom 'Doxxed': while in play, the top of BOTH decks is public for everyone", () => {
    let st = M.newGame({ players: [0, 1], mainDeck: 20, faithDeck: 5, startingHand: 0, cardRegistry: baseSet });
    st = M.reduce(st, { type: M.ActionType.DRAW_RESOLVES });
    st = M.replace(st, { instances: { ...st.instances, jane: mk("jane", "MJG-047", { atk: 0, def: 6, value: 4 }) } });
    const sess = new GameSession(st);
    expect(sess.viewFor(1).deckTop).toBeNull(); // not in play yet
    expect(sess.viewFor(1).faithTop).toBeNull();
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, board: [...p.board, "jane"] } : p)) });
    expect(sess.viewFor(1).deckTop?.iid).toBe(sess.state.mainDeck[0]);
    expect(sess.viewFor(1).faithTop?.iid).toBe(sess.state.faithDeck[0]);
    expect(sess.viewFor(0).faithTop?.iid).toBe(sess.state.faithDeck[0]); // both seats see it
    // face-down Jane4 -> the passive is off
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, jane: { ...sess.state.instances["jane"]!, faceDown: true } } });
    expect(sess.viewFor(1).deckTop).toBeNull();
    expect(sess.viewFor(1).faithTop).toBeNull();
  });
});

describe("MJG-M02 I'm at the bar...", () => {
  it("top 'Siscon': steal a strictly weaker FEMALE to your hand; then SS this card", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("bart", "MJG-M02", { atk: 2, def: 2, value: 3 }));
        p("board", 1, mk("weakf", "MJG-011", { atk: 1, def: 1, value: 1 })); // FEMALE, strictly weaker
        p("board", 1, mk("strongf", "MJG-011", { atk: 2, def: 1, value: 1 })); // FEMALE but ATK ties
        p("board", 1, mk("weakm", "MJG-M07", { atk: 1, def: 1, value: 1 })); // weaker but MALE
      }),
    );
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "bart") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetIds).toEqual(["weakf"]); // gender + all-three-stats filters
    sess.command(0, { do: "activate", iid: "bart", role: "top", targets: ["weakf"] });
    expect(M.player(sess.state, 0).hand).toContain("weakf"); // stolen to YOUR hand
    expect(M.player(sess.state, 1).board).not.toContain("weakf");
    expect(M.player(sess.state, 0).board).toContain("bart"); // then SS'd
  });

  it("bottom 'The Usual?': reveal the top 3 at activation; the target picks 1, you take 2", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("bart", "MJG-M02", { atk: 2, def: 2, value: 3 }));
      }),
    );
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, t0: mk("t0", "MJG-011"), t1: mk("t1", "MJG-013"), t2: mk("t2", "MJG-018") },
      mainDeck: ["t0", "t1", "t2", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "bart", role: "bottom", targets: ["1"] });
    expect(sess.state.log.some((l) => l.includes("reveals the top 3"))).toBe(true); // public at activation
    // the TARGET picks one of the revealed three
    expect(sess.viewFor(1).choice?.options.map((o) => o.iid).sort()).toEqual(["t0", "t1", "t2"]);
    sess.choose(1, { use: true, target: "t1" });
    expect(M.player(sess.state, 1).hand).toContain("t1"); // their pick
    expect(M.player(sess.state, 0).hand).toEqual(expect.arrayContaining(["t0", "t2"])); // you take the rest
    expect(sess.state.mainDeck).not.toEqual(expect.arrayContaining(["t0", "t1", "t2"]));
  });
});

describe("MJG-M03 Senba Crow", () => {
  it("top 'SS': target any player controlling a [Hag] (self allowed); SS to THEIR board; then draw", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("crow", "MJG-M03", { atk: 1, def: 1, value: 1 }));
        p("board", 0, mk("myhag", "", { tribes: ["Hag"] }));
        p("board", 1, mk("theirhag", "", { tribes: ["Hag"] }));
      }),
    );
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "crow") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetSeats?.sort()).toEqual([0, 1]); // BOTH players control a Hag — self included
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "crow", role: "top", targets: ["1"] });
    expect(M.player(sess.state, 1).board).toContain("crow"); // on THEIR board (they control it)
    expect(M.player(sess.state, 0).board).not.toContain("crow");
    expect(sess.state.mainDeck.length).toBe(deck0 - 1); // then YOU drew 1
  });

  it("top: a player without a [Hag] is not a valid seat", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("crow", "MJG-M03", { atk: 1, def: 1, value: 1 }));
        p("board", 1, mk("theirhag", "", { tribes: ["Hag"] })); // only p1 qualifies
      }),
    );
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "crow") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetSeats).toEqual([1]);
    expect(sess.command(0, { do: "activate", iid: "crow", role: "top", targets: ["0"] }).ok).toBe(false); // self invalid here
  });

  it("bottom 'Hag Love': SS a [Hag] from hand (only Hags offered); then draw 1", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("crow", "MJG-M03", { atk: 1, def: 1, value: 1 }));
        p("hand", 0, mk("hag", "", { atk: 2, def: 2, tribes: ["Hag"] }));
        p("hand", 0, mk("nothag", "", { atk: 2, def: 2 }));
      }),
    );
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "crow", role: "bottom" });
    const ch = sess.viewFor(0).choice;
    expect(ch?.handPick).toBe("summon");
    expect(ch?.options.map((o) => o.iid)).toEqual(["hag"]); // non-Hags filtered out
    sess.choose(0, { use: true, target: "hag" });
    expect(M.player(sess.state, 0).board).toContain("hag");
    expect(sess.state.mainDeck.length).toBe(deck0 - 1); // then drew 1
  });
});

describe("MJG-M04 RUSSIAN", () => {
  it("top 'Collusion': discard + show your hand at activation; they show back -> both draw 3", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("rus", "MJG-M04", { atk: 3, def: 0, value: 4 }));
        p("hand", 0, mk("secret", "MJG-011"));
        p("hand", 1, mk("their", "MJG-013"));
      }),
    );
    const h0 = M.player(sess.state, 0).hand.length;
    const h1 = M.player(sess.state, 1).hand.length;
    sess.command(0, { do: "activate", iid: "rus", role: "top", targets: ["1"] });
    // the cost is paid up front: discarded, and YOUR hand is shown to them
    expect(sess.state.discard).toContain("rus");
    const shown = sess.viewFor(1).revealedHands.find((r) => r.owner === 0);
    expect(shown?.cards.some((c) => c.iid === "secret" && c.cardId === "MJG-011")).toBe(true);
    expect(sess.viewFor(0).revealedHands).toEqual([]); // nothing shown to YOU yet
    // the target's yes/no is answered ON the shown-hand popup (revealOwner drives it)
    expect(sess.viewFor(1).choice?.revealOwner).toBe(0);
    // the target agrees to show theirs back
    sess.choose(1, { use: true });
    // PRE-draw: the activator now sees the target's hand and must CONFIRM before the draws
    expect(M.player(sess.state, 0).hand.length).toBe(h0 - 1); // no draws yet (rus discarded)
    expect(M.player(sess.state, 1).hand.length).toBe(h1);
    const ackCh = sess.viewFor(0).choice;
    expect(ackCh?.revealOwner).toBe(1);
    expect(ackCh?.ack).toBe(true); // confirm-only popup
    expect(sess.viewFor(0).revealedHands.find((r) => r.owner === 1)?.cards.some((c) => c.iid === "their")).toBe(true);
    sess.choose(0, { use: true }); // the activator confirms -> the draws resolve
    expect(M.player(sess.state, 0).hand.length).toBe(h0 - 1 + 3); // -rus +3
    expect(M.player(sess.state, 1).hand.length).toBe(h1 + 3);
    // the deal is done: BOTH hands go straight back to private info
    expect(sess.viewFor(0).revealedHands).toEqual([]);
    expect(sess.viewFor(1).revealedHands).toEqual([]);
  });

  it("top: they decline -> no draws (your hand was still shown)", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("rus", "MJG-M04", { atk: 3, def: 0, value: 4 }))));
    const h1 = M.player(sess.state, 1).hand.length;
    sess.command(0, { do: "activate", iid: "rus", role: "top", targets: ["1"] });
    sess.choose(1, { use: false });
    expect(M.player(sess.state, 1).hand.length).toBe(h1); // no draws
    expect(sess.viewFor(1).revealedHands).toEqual([]); // rejected: the shown hand is private again
    expect(sess.viewFor(0).revealedHands).toEqual([]);
  });

  it("top: negated (Koito) -> no yes/no popup for the target; the shown hand is taken back", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("rus", "MJG-M04", { atk: 3, def: 0, value: 4 }));
        p("hand", 0, mk("koit", "MJG-C31", { value: 1 }));
      }),
    );
    const h1 = M.player(sess.state, 1).hand.length;
    sess.setToggle(0, "always"); // Collusion reveals the ACTIVATOR's hand, so THEY can Koito it
    sess.command(0, { do: "activate", iid: "rus", role: "top", targets: ["1"] });
    expect(sess.awaiting).toBe(0);
    sess.respond(0, { activate: { iid: "koit", role: "top" } });
    // negated: the target never gets the shown-hand yes/no, and the show is taken back
    expect(sess.viewFor(1).choice).toBeFalsy();
    expect(sess.state.handRevealedTo).toEqual([]);
    expect(sess.viewFor(1).revealedHands).toEqual([]);
    expect(M.player(sess.state, 1).hand.length).toBe(h1); // no draws
  });

  it("bottom 'Target Ron' (once per game): both sides pick a meld to discard", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("rus", "MJG-M04", { atk: 3, def: 0, value: 4 }));
      }),
    );
    const meld = (ids: string[]) => ({ cards: ids, kind: "triplet" as const, kan: false });
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, m1: mk("m1"), m2: mk("m2"), m3: mk("m3"), o1: mk("o1"), o2: mk("o2"), o3: mk("o3") },
      players: sess.state.players.map((p) =>
        p.pid === 0 ? { ...p, meldZone: [meld(["m1", "m2", "m3"])] } : { ...p, meldZone: [meld(["o1", "o2", "o3"])] },
      ),
    });
    sess.command(0, { do: "activate", iid: "rus", role: "bottom", targets: ["1"] });
    sess.choose(0, { use: true, target: "0" }); // your meld
    sess.choose(1, { use: true, target: "0" }); // their meld
    expect(M.player(sess.state, 0).meldZone).toEqual([]);
    expect(M.player(sess.state, 1).meldZone).toEqual([]);
    expect(sess.state.discard).toEqual(expect.arrayContaining(["m1", "m2", "m3", "o1", "o2", "o3"]));
    // once per game: never offered again (even with a meld back)
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, rus: { ...sess.state.instances["rus"]!, tapped: false } },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, meldZone: [meld(["m1", "m2", "m3"])] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "rus" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-M06 Szocjidgdgiharaze", () => {
  it("top 'RAWN': discard this; then place the target on the BOTTOM of the discard pile", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("josp", "MJG-M06", { atk: 6, def: 2, value: 4 }));
        p("board", 1, mk("vic", "", { atk: 3, def: 3 }));
      }),
    );
    sess.command(0, { do: "activate", iid: "josp", role: "top", targets: ["vic"] });
    expect(sess.state.discard).toContain("josp"); // the cost-step discard
    expect(sess.state.discard[sess.state.discard.length - 1]).toBe("vic"); // bottom of the pile
    expect(M.player(sess.state, 1).board).not.toContain("vic");
  });

  it("bottom 'TSUOM': melding it makes each opponent pick a hand discard", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("josp", "MJG-M06", { atk: 6, def: 2, value: 4 }));
        p("board", 0, mk("a", "", { value: 4 }));
        p("board", 0, mk("b", "", { value: 4 }));
        p("hand", 1, mk("x"));
        p("hand", 1, mk("y"));
      }),
    );
    expect(sess.command(0, { do: "meld", materials: ["josp", "a", "b"] }).ok).toBe(true); // 4-4-4 triplet
    // the meld trigger prompts the opponent with the hand-pick discard UI
    const ch = sess.viewFor(1).choice;
    expect(ch?.handPick).toBe("discard");
    expect(ch?.prompt).toMatch(/TSUOM/);
    sess.choose(1, { use: true, target: "x" });
    expect(sess.state.discard).toContain("x");
    expect(M.player(sess.state, 1).hand).toContain("y"); // only one discarded
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE);
  });
});

describe("MJG-M07 El Primer Furry", () => {
  it("bottom 'Slippery Slope': search the deck for a [Furry] -> hand, then SHUFFLE", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("fury", "MJG-M07", { atk: 3, def: 3, value: 1, tribes: ["Furry"] }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, f1: mk("f1", "MJG-0w0", { tribes: ["Furry"] }), plain: mk("plain", "MJG-011") },
      mainDeck: ["plain", "f1", ...sess.state.mainDeck], // the Furry sits BELOW the top
    });
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "fury", role: "bottom" });
    // the search shows ONLY deck Furries, to the controller only
    expect(sess.viewFor(0).choice?.options.map((o) => o.iid)).toEqual(["f1"]);
    expect(sess.viewFor(1).choice).toBeNull();
    sess.choose(0, { use: true, target: "f1" });
    expect(M.player(sess.state, 0).hand).toContain("f1");
    expect(sess.state.mainDeck.length).toBe(deck0 - 1);
    expect(sess.state.log.some((l) => l.includes("added from the deck"))).toBe(true); // public pull
    expect(sess.state.log.some((l) => l.includes("the deck is shuffled"))).toBe(true); // searched -> shuffled
  });

  it("bottom: always activatable — a search can find NOTHING, the player is told, the deck still shuffles", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("fury", "MJG-M07", { atk: 3, def: 3, value: 1, tribes: ["Furry"] }))));
    // no Furry anywhere in the deck — the search is still offered
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "fury" && a.role === "bottom")).toBe(true);
    const hand0 = M.player(sess.state, 0).hand.length;
    sess.command(0, { do: "activate", iid: "fury", role: "bottom" });
    expect(sess.viewFor(0).choice).toBeNull(); // nothing to pick — resolves immediately
    expect(M.player(sess.state, 0).hand.length).toBe(hand0); // found nothing
    expect(sess.state.log.some((l) => l.includes("nothing found"))).toBe(true); // the player is told
    expect(sess.state.log.some((l) => l.includes("the deck is shuffled"))).toBe(true); // still shuffled
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE);
  });

  it("Cheese Chotto's deck search also shuffles now", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("chio", "MJG-003"))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, th: mk("th", "AS4-PIN") },
      mainDeck: [...sess.state.mainDeck, "th"], // TO Here buried in the deck
    });
    sess.command(0, { do: "summon", iid: "chio" });
    sess.choose(0, { use: true, target: "th" }); // take the DECK copy
    expect(M.player(sess.state, 0).board).toContain("th");
    expect(sess.state.log.some((l) => l.includes("the deck is shuffled"))).toBe(true);
  });
});

describe("MJG-M09 It's Actually Over", () => {
  it("top 'Tie the Noose': an anytime self-discard — pure chain fodder", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("v", "MJG-011"));
        p("hand", 1, mk("ztsu", "MJG-M09", { atk: 1, def: 0, value: 1 }));
      }),
    );
    sess.setToggle(1, "auto");
    sess.command(0, { do: "summon", iid: "v" }); // any opponent action to respond to
    expect(sess.awaiting).toBe(1);
    sess.respond(1, { activate: { iid: "ztsu", role: "top" } });
    expect(sess.state.discard).toContain("ztsu"); // discarded itself
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE);
  });

  it("bottom 'Going to Gensokyo': a SPECIAL Summon discards it; a Normal Summon doesn't", () => {
    // Normal Summon: it stays
    const a = new GameSession(setup((p) => p("hand", 0, mk("ztsu", "MJG-M09", { atk: 1, def: 0, value: 1 }))));
    a.command(0, { do: "summon", iid: "ztsu" });
    expect(M.player(a.state, 0).board).toContain("ztsu");
    expect(a.state.discard).not.toContain("ztsu");
    // Special Summon (Koko Doko makes the opponent SS their only hand card): it goes
    const b = new GameSession(
      setup((p) => {
        p("hand", 0, mk("koko", "FAT-009"));
        p("hand", 1, mk("ztsu", "MJG-M09", { atk: 1, def: 0, value: 1 })); // their only card
      }),
    );
    b.command(0, { do: "summon", iid: "koko" });
    expect(M.player(b.state, 1).board).not.toContain("ztsu"); // summoned, then Gensokyo'd
    expect(b.state.discard).toContain("ztsu");
  });
});

describe("MJG-M18 El Negro Kang", () => {
  it("bottom 'Immigration': SS a [Furry] from the discard pile — only Furries offered", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("kang", "MJG-M18", { atk: 3, def: 3, value: 1, tribes: ["Furry"] }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, fur: mk("fur", "MJG-0w0", { tribes: ["Furry"] }), plain: mk("plain", "MJG-011") },
      discard: ["fur", "plain"],
    });
    sess.command(0, { do: "activate", iid: "kang", role: "bottom" });
    const ch = sess.viewFor(0).choice;
    expect(ch?.options.map((o) => o.iid)).toEqual(["fur"]); // non-Furry filtered out
    sess.choose(0, { use: true, target: "fur" });
    expect(M.player(sess.state, 0).board).toContain("fur"); // special-summoned
    expect(sess.state.discard).not.toContain("fur");
  });

  it("bottom: not offered without a [Furry] in the discard", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("kang", "MJG-M18", { atk: 3, def: 3, value: 1, tribes: ["Furry"] }))));
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, plain: mk("plain", "MJG-011") }, discard: ["plain"] });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "kang" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-M10 GrinchChads", () => {
  it("'Special Summoned this turn' is tracked: set on an effect SS, NOT on a normal summon, cleared at turn change", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("ny", "MJG-001")); // Nyagger bottom (board Active) SS's the deck top
        p("board", 0, mk("normal", "MJG-011")); // placed via setup, not summoned
      }),
    );
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, top: mk("top", "MJG-013") },
      mainDeck: ["top", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "ny", role: "bottom" }); // SS the deck top
    expect(sess.state.instances["top"]?.ssThisTurn).toBe(true); // effect SS -> flagged
    expect(sess.state.instances["normal"]?.ssThisTurn).toBeFalsy(); // not summoned by effect
    // clears at the turn change
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    expect(sess.state.instances["top"]?.ssThisTurn).toBe(false);
  });

  it("top 'Game Limit': discard this; shuffle EXACTLY 2 opponent SS'd-this-turn characters into the deck", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("koko", "FAT-009"));
        p("hand", 1, mk("o1", "MJG-011"));
        p("hand", 1, mk("o2", "MJG-013"));
        p("hand", 0, mk("knae", "MJG-M10", { atk: 2, def: 2, value: 2 }));
        p("board", 0, mk("old", "MJG-011")); // an old (not-this-turn) board card
      }),
    );
    // Koko Doko makes the opponent SS a random hand card... but only one. Give them
    // two SS'd cards by summoning Koko twice is overkill — instead, flag them directly.
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances,
        o1: { ...sess.state.instances["o1"]!, ssThisTurn: true },
        o2: { ...sess.state.instances["o2"]!, ssThisTurn: true },
      },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, board: ["o1", "o2"], hand: [] } : p)),
    });
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "knae") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targets).toBe(2);
    expect(act?.targetIds?.sort()).toEqual(["o1", "o2"]); // only opponent SS'd-this-turn; not "old"
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "knae", role: "top", targets: ["o1", "o2"] });
    expect(sess.state.discard).toContain("knae"); // the cost-step discard
    expect(M.player(sess.state, 1).board).toEqual([]); // both shuffled away
    expect(sess.state.mainDeck.length).toBe(deck0 + 2);
    expect(sess.state.log.some((l) => l.includes("shuffled into the deck"))).toBe(true);
  });

  it("top: not offered with fewer than 2 SS'd-this-turn opponent characters", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("knae", "MJG-M10", { atk: 2, def: 2, value: 2 }));
        p("board", 1, mk("o1", "MJG-011"));
      }),
    );
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, o1: { ...sess.state.instances["o1"]!, ssThisTurn: true } } });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "knae")).toBe(false); // only 1 candidate
  });

  it("bottom 'Grinch': draw 2, then shuffle THIS card into the deck", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("knae", "MJG-M10", { atk: 2, def: 2, value: 2 }))));
    const hand0 = M.player(sess.state, 0).hand.length;
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "knae", role: "bottom" });
    expect(M.player(sess.state, 0).hand.length).toBe(hand0 + 2); // drew 2
    expect(M.player(sess.state, 0).board).not.toContain("knae"); // shuffled itself away
    expect(sess.state.mainDeck.length).toBe(deck0 - 2 + 1); // -2 drawn, +1 self
  });
});

describe("MJG-M11 My /mjg/ Crush", () => {
  it("top 'Cupid Doesn't Exist': it cannot attack and cannot be attacked", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("crush", "MJG-M11", { atk: 0, def: 1, value: 2 }));
        p("board", 0, mk("ally", "", { atk: 5, def: 5 }));
        p("board", 1, mk("foe", "", { atk: 5, def: 5 }));
      }),
    );
    // it can't attack: no attack action offered on it
    expect(sess.viewFor(0).legal.some((a) => a.kind === "attack" && a.iid === "crush")).toBe(false);
    expect(sess.viewFor(0).legal.some((a) => a.kind === "attack" && a.iid === "ally")).toBe(true);
    // it can't be attacked: the opponent's attack on it is rejected
    sess.state = M.replace(sess.state, { activePlayer: 1 });
    expect(sess.command(1, { do: "attack", attacker: "foe", target: "crush" }).ok).toBe(false);
    // it's flagged unattackable in the view (so the client won't highlight it)
    expect(sess.viewFor(1).players.find((p) => p.pid === 0)!.board.find((c) => c.iid === "crush")!.unattackable).toBe(true);
  });

  it("bottom 'Matchmaker': the 2 targets can't attack each other and share a discard fate; lapses next turn", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("crush", "MJG-M11", { atk: 0, def: 1, value: 2 }));
        p("board", 0, mk("hit", "", { atk: 9, def: 9 })); // a beater to discard x by battle
        p("board", 1, mk("x", "", { atk: 1, def: 1 }));
        p("board", 1, mk("y", "", { atk: 1, def: 1 }));
      }),
    );
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "crush" && a.role === "bottom") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetIds).not.toContain("crush"); // "2 OTHER characters"
    sess.command(0, { do: "activate", iid: "crush", role: "bottom", targets: ["x", "y"] });
    // attacking x (9 > 1) discards it; the bond drags its partner y to the discard too
    sess.command(0, { do: "attack", attacker: "hit", target: "x" });
    expect(sess.state.discard).toEqual(expect.arrayContaining(["x", "y"]));
    expect(M.player(sess.state, 1).board).toEqual([]);
    expect(sess.state.log.some((l) => l.includes("shares its partner's fate"))).toBe(true);
  });

  it("bottom: the bond blocks the pair attacking each other, and lapses at the start of your next turn", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("crush", "MJG-M11", { atk: 0, def: 1, value: 2 }));
        p("board", 1, mk("x", "", { atk: 9, def: 1 }));
        p("board", 1, mk("y", "", { atk: 1, def: 9 }));
      }),
    );
    sess.command(0, { do: "activate", iid: "crush", role: "bottom", targets: ["x", "y"] });
    // the bond is public on every seat's view (the client badges both halves)
    expect(sess.viewFor(0).bonds).toEqual([{ a: "x", b: "y" }]);
    expect(sess.viewFor(1).bonds).toEqual([{ a: "x", b: "y" }]);
    sess.state = M.replace(sess.state, { activePlayer: 1 });
    expect(sess.command(1, { do: "attack", attacker: "x", target: "y" }).ok).toBe(false); // bonded
    // a full turn cycle back to the activator (p0) lapses the bond
    sess.state = M.reduce(M.replace(sess.state, { activePlayer: 1, phase: M.Phase.TURN_END }), { type: M.ActionType.ADVANCE }); // -> p0
    expect(sess.state.matchmakerBonds).toEqual([]);
    expect(sess.viewFor(0).bonds).toEqual([]); // the badge disappears with the lapse
  });
});

describe("MJG-M12 i'm in your walls", () => {
  it("bottom 'Second Amendment': an opponent's summon on their turn is immediately attacked (two-sided)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("vic", "", { atk: 1, def: 1 })); // seat 0 will normal-summon this
        p("board", 1, mk("gun", "MJG-M12", { atk: 7, def: 0, value: 3 })); // the opponent's M12
      }),
    );
    sess.command(0, { do: "summon", iid: "vic" });
    // mandatory: gun immediately attacks vic. 7 ATK > 1 DEF -> vic discarded; the battle
    // is TWO-sided, so vic's 1 ATK > gun's 0 DEF discards gun too.
    expect(sess.state.discard).toEqual(expect.arrayContaining(["vic", "gun"]));
    expect(M.player(sess.state, 0).board).not.toContain("vic");
    expect(M.player(sess.state, 1).board).not.toContain("gun");
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE);
    expect(sess.awaiting).toBeNull();
  });

  it("bottom: it does NOT fire on the controller's own summon (only an opponent's)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("own", "", { atk: 1, def: 1 }));
        p("board", 0, mk("gun", "MJG-M12", { atk: 7, def: 0, value: 3 })); // gun on the ACTIVE player's board
      }),
    );
    sess.command(0, { do: "summon", iid: "own" }); // seat 0 summons; gun is seat 0's own card
    expect(M.player(sess.state, 0).board).toEqual(expect.arrayContaining(["own", "gun"])); // no attack
    expect(sess.state.discard).not.toContain("own");
  });

  // put a trigger-free blank on top of the deck, then have seat 0 take its turn draw —
  // so the ONLY trigger on that draw is the opponent's fOUnD hand-trap. `events: []`
  // drops the unprocessed turn-draw event setup left behind (setup never settles).
  const drawBlank = (sess: GameSession) => {
    sess.state = M.replace(sess.state, {
      phase: M.Phase.TURN_START_DRAW,
      events: [],
      instances: { ...sess.state.instances, blank: mk("blank") },
      mainDeck: ["blank", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "draw" });
  };

  it("top 'fOUnD mEeEeee': chains to an opponent's draw — SS this card, then one-sided attack the drawer's character", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("vic", "", { atk: 5, def: 1 })); // the drawer's character
        p("hand", 1, mk("gun", "MJG-M12", { atk: 7, def: 0, value: 3 })); // seat 1's hand-trap
      }),
    );
    sess.setToggle(1, "auto"); // reactive optional triggers need the toggle on
    drawBlank(sess); // seat 0's turn draw — fOUnD chains to THAT draw
    // seat 1 is offered the hand-trap (an optional trigger on the draw event)
    expect(sess.viewFor(1).choice).not.toBeNull();
    sess.choose(1, { use: true }); // accept -> Special Summon gun
    expect(M.player(sess.state, 1).board).toContain("gun");
    // step 1 (after the `then` window): attack the DRAWER's character, one-sided
    expect(sess.viewFor(1).choice).not.toBeNull();
    sess.choose(1, { use: true }); // yes, attack
    sess.choose(1, { use: true, target: "vic" });
    expect(sess.state.discard).toContain("vic"); // 7 ATK > 1 DEF -> discarded
    expect(M.player(sess.state, 1).board).toContain("gun"); // one-sided: the victim never fights back
    expect(sess.state.discard).not.toContain("gun");
  });

  it("top: the holder can decline the attack — it just Special Summons", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("vic", "", { atk: 5, def: 1 }));
        p("hand", 1, mk("gun", "MJG-M12", { atk: 7, def: 0, value: 3 }));
      }),
    );
    sess.setToggle(1, "auto"); // reactive optional triggers need the toggle on
    drawBlank(sess);
    sess.choose(1, { use: true }); // accept the trigger -> SS gun
    sess.choose(1, { use: false }); // decline the attack
    expect(M.player(sess.state, 1).board).toContain("gun"); // still summoned
    expect(sess.state.discard).not.toContain("vic"); // not attacked
    expect(sess.state.phase).toBe(M.Phase.MAIN_PHASE);
  });

  it("top: a holder with their chain toggle OFF is never prompted (silently declined)", () => {
    const sess = new GameSession(setup((p) => p("hand", 1, mk("gun", "MJG-M12", { atk: 7, def: 0, value: 3 }))));
    // default toggle is "off" — the opponent's draw must NOT open the fOUnD mEeEeee prompt
    sess.command(0, { do: "draw" });
    expect(sess.viewFor(1).choice).toBeFalsy();
    expect(M.player(sess.state, 1).hand).toContain("gun"); // stayed in hand, no SS
  });

  it("top: chains only to an OPPONENT's draw (never the holder's own), and is fully optional", () => {
    const s = setup((p) => p("hand", 1, mk("gun", "MJG-M12", { atk: 7, def: 0, value: 3 })));
    // (toggle "auto" so the reactive trigger may prompt at all)
    // an OPPONENT (seat 0) drawing collects the hand-trap for the holder (seat 1)
    const onOpp = collectTriggers(s, [{ kind: "draw", iid: "x", player: 0 }]);
    expect(onOpp.some((t) => t.id === "MJG-M12:top" && t.player === 1)).toBe(true);
    // the HOLDER (seat 1) drawing does NOT — only opponents react to a draw
    const onSelf = collectTriggers(s, [{ kind: "draw", iid: "x", player: 1 }]);
    expect(onSelf.some((t) => t.id === "MJG-M12:top")).toBe(false);
    // and the holder can simply decline the optional trigger (the card stays in hand)
    const sess = new GameSession(setup((p) => p("hand", 1, mk("gun", "MJG-M12", { atk: 7, def: 0, value: 3 }))));
    sess.setToggle(1, "auto");
    drawBlank(sess);
    expect(sess.viewFor(1).choice).not.toBeNull(); // offered the trigger
    sess.choose(1, { use: false }); // decline it entirely
    expect(M.player(sess.state, 1).hand).toContain("gun"); // stays in hand
    expect(M.player(sess.state, 1).board).not.toContain("gun");
  });
});

describe("MJG-M13 Famous Fagat", () => {
  it("top 'Trap Trick' (At any time): flip a character face-down until the END of this turn, and SS this card", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("v", "MJG-011")); // seat 0 acts to open a response window
        p("board", 0, mk("foe", "", { atk: 5, def: 5 })); // the targeted character
        p("hand", 1, mk("fag", "MJG-M13", { atk: 2, def: 1, value: 2 }));
      }),
    );
    sess.setToggle(1, "auto");
    sess.command(0, { do: "summon", iid: "v" }); // opens a window seat 1 can respond in
    expect(sess.awaiting).toBe(1);
    sess.respond(1, { activate: { iid: "fag", role: "top", targets: ["foe"] } });
    expect(sess.state.instances["foe"]?.faceDown).toBe(true); // flipped face-down
    expect(M.player(sess.state, 1).board).toContain("fag"); // Special Summoned itself
    // it flips back at the END of THIS (seat 0's) turn
    sess.command(0, { do: "endTurn" });
    expect(sess.state.instances["foe"]?.faceDown).toBe(false); // face-up again
    expect(sess.state.log.some((l) => l.includes("end of player 0's turn"))).toBe(true);
  });

  it("top: the flip lasts the WHOLE current turn (it does not flip up at a mere turn advance)", () => {
    // flip during seat 1's turn -> it stays down through seat 1's turn, flips up only
    // when seat 1 ENDS their turn (not when an unrelated turn starts).
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("foe", "", { atk: 5, def: 5 }));
        p("hand", 1, mk("fag", "MJG-M13", { atk: 2, def: 1, value: 2 }));
      }),
    );
    sess.setToggle(1, "always");
    sess.state = M.replace(sess.state, { activePlayer: 1, phase: M.Phase.MAIN_PHASE }); // seat 1's turn
    sess.command(1, { do: "activate", iid: "fag", role: "top", targets: ["foe"] });
    expect(sess.state.instances["foe"]?.faceDown).toBe(true);
    expect(M.player(sess.state, 1).board).toContain("fag");
    sess.command(1, { do: "endTurn" }); // seat 1 ends their turn -> flips back
    expect(sess.state.instances["foe"]?.faceDown).toBe(false);
  });

  it("bottom 'Gay ERP': swap control with an opponent character; this card goes face-down on their board", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("fag", "MJG-M13", { atk: 2, def: 1, value: 2 })); // seat 0's, on board
        p("board", 1, mk("theirs", "", { atk: 4, def: 4 })); // the opponent's character
      }),
    );
    sess.command(0, { do: "activate", iid: "fag", role: "bottom", targets: ["theirs"] });
    // swapped: fag now on seat 1's board (face-down), theirs on seat 0's board
    expect(M.player(sess.state, 1).board).toContain("fag");
    expect(M.player(sess.state, 0).board).toContain("theirs");
    expect(M.player(sess.state, 0).board).not.toContain("fag");
    expect(sess.state.instances["fag"]?.faceDown).toBe(true);
    // it flips back at the START of that opponent's (seat 1's) next turn
    sess.state = M.reduce(M.replace(sess.state, { activePlayer: 0, phase: M.Phase.TURN_END }), { type: M.ActionType.ADVANCE }); // -> seat 1
    expect(sess.state.instances["fag"]?.faceDown).toBe(false);
  });

  it("bottom: only an OPPONENT's character is a legal target (not your own)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("fag", "MJG-M13", { atk: 2, def: 1, value: 2 }));
        p("board", 0, mk("mine", "", { atk: 3, def: 3 })); // own character
        p("board", 1, mk("theirs", "", { atk: 4, def: 4 })); // opponent's
      }),
    );
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "fag" && a.role === "bottom") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetIds).toContain("theirs");
    expect(act?.targetIds).not.toContain("mine");
    expect(act?.targetIds).not.toContain("fag");
  });
});

describe("MJG-M14 Divegrass is Ruined!", () => {
  it("top 'CAM ON MJG': SS a chosen hand card to the opponent's board, then SS this card to yours", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("soc", "MJG-M14", { atk: 7, def: 1, value: 2 }));
        p("hand", 0, mk("gift", "", { atk: 3, def: 3, value: 1 }));
      }),
    );
    sess.command(0, { do: "activate", iid: "soc", role: "top", targets: ["1"] });
    // pick the hand card to hand over (this card itself is not offered)
    const opts = sess.viewFor(0).choice?.options.map((o) => o.iid) ?? [];
    expect(opts).toContain("gift");
    expect(opts).not.toContain("soc"); // the source itself is excluded
    sess.choose(0, { use: true, target: "gift" });
    expect(M.player(sess.state, 1).board).toContain("gift"); // given to the opponent
    expect(M.player(sess.state, 0).board).toContain("soc"); // this card on your board
    expect(M.player(sess.state, 0).hand).not.toContain("gift");
    expect(M.player(sess.state, 0).hand).not.toContain("soc");
  });

  it("top: not activatable without a summonable card (other than itself) to give", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("soc", "MJG-M14", { atk: 7, def: 1, value: 2 }))));
    // hand holds only this card (drop the auto-drawn turn card) -> nothing to give
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["soc"] } : p)) });
    expect(sess.viewFor(0).legal.some((x) => x.kind === "activate" && x.iid === "soc" && x.role === "top")).toBe(false);
    // a second summonable hand card makes it activatable
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, gift: mk("gift", "", { value: 1 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["soc", "gift"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((x) => x.kind === "activate" && x.iid === "soc" && x.role === "top")).toBe(true);
  });

  it("bottom 'SCOR SOM FACKIN MANGANS': meld the opponent's VALUE-1 & VALUE-3 with this card (1-2-3)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("soc", "MJG-M14", { atk: 7, def: 1, value: 2 })); // VALUE 2
        p("board", 1, mk("one", "", { atk: 1, def: 1, value: 1 })); // opponent's VALUE 1
        p("board", 1, mk("three", "", { atk: 1, def: 1, value: 3 })); // opponent's VALUE 3
      }),
    );
    const melds0 = M.player(sess.state, 0).meldZone.length;
    sess.command(0, { do: "activate", iid: "soc", role: "bottom", targets: ["1"] });
    const mz = M.player(sess.state, 0).meldZone;
    expect(mz.length).toBe(melds0 + 1); // a meld appears in YOUR meld zone
    expect([...mz[mz.length - 1]!.cards].sort()).toEqual(["one", "soc", "three"]);
    expect(mz[mz.length - 1]!.kind).toBe("sequence"); // 1-2-3
    expect(M.player(sess.state, 1).board).toEqual([]); // the opponent's two characters left
    expect(M.player(sess.state, 0).board).not.toContain("soc"); // this card became a material
  });

  it("bottom: only offered against an opponent controlling both a VALUE-1 and a VALUE-3", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("soc", "MJG-M14", { atk: 7, def: 1, value: 2 }));
        p("board", 1, mk("one", "", { value: 1 })); // VALUE-1 only — no VALUE-3
      }),
    );
    expect(sess.viewFor(0).legal.some((x) => x.kind === "activate" && x.iid === "soc" && x.role === "bottom")).toBe(false);
    // add a VALUE-3 -> now offered
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, three: mk("three", "", { value: 3 }) },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, board: [...p.board, "three"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((x) => x.kind === "activate" && x.iid === "soc" && x.role === "bottom")).toBe(true);
  });
});

describe("HTTP-404 The Hacker known as 4chan", () => {
  it("top 'BSoD': SS this card to the opponent's board, then banish a random card from their hand", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("hax", "HTTP-404", { atk: 0, def: 4, value: 4 }));
        p("hand", 1, mk("victim", "", { value: 5 })); // their only hand card -> the random pick is forced
      }),
    );
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, older: mk("older", "") },
      banish: ["older"], // pre-existing banished card: the new banish goes ON TOP
    });
    sess.command(0, { do: "activate", iid: "hax", role: "top", targets: ["1"] });
    expect(M.player(sess.state, 1).board).toContain("hax"); // summoned to THEIR board
    expect(sess.state.banish).toEqual(["victim", "older"]); // banished to the TOP of the pile
    expect(M.player(sess.state, 1).hand).not.toContain("victim");
  });

  it("top: with an empty opponent hand the SS still happens, the banish just whiffs", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("hax", "HTTP-404", { atk: 0, def: 4, value: 4 }))));
    sess.command(0, { do: "activate", iid: "hax", role: "top", targets: ["1"] });
    expect(M.player(sess.state, 1).board).toContain("hax");
    expect(sess.state.banish).toEqual([]);
  });

  it("bottom 'Malware': its controller is not offered reveal effects (e.g. 'I'm Looking!')", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("hax", "HTTP-404", { atk: 0, def: 4, value: 4, tribes: ["Schizo"] }));
        p("hand", 0, mk("look", "MJG-002")); // I'm Looking! — a reveal SPELL
      }),
    );
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "look")).toBe(false);
    // a non-reveal hand SPELL is still fine
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, ny: mk("ny", "MJG-001") },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: [...p.hand, "ny"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "ny" && a.role === "top")).toBe(true);
  });

  it("bottom: HTTP-404 is not offered as a meld material (Malware)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("hax", "HTTP-404", { atk: 0, def: 4, value: 4 }));
        p("board", 0, mk("a", "", { value: 4 }));
        p("board", 0, mk("b", "", { value: 4 }));
      }),
    );
    // hax + a + b would be a 4-4-4 triplet, but hax can't be melded -> no meld offered
    expect(sess.viewFor(0).legal.some((x) => x.kind === "meld")).toBe(false);
  });
});

describe("MJG-M19 Flow Book 1", () => {
  it("top 'Tile Efficiency': SS this card and force the opponent to meld 3 of their characters (no Faith)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("fb", "MJG-M19", { atk: 3, def: 1, value: 5 }));
        p("board", 1, mk("a", "", { value: 1 }));
        p("board", 1, mk("b", "", { value: 2 }));
        p("board", 1, mk("c", "", { value: 3 })); // 1-2-3 sequence
      }),
    );
    const hand1 = M.player(sess.state, 1).hand.length;
    const faith0 = sess.state.faithDeck.length;
    sess.command(0, { do: "activate", iid: "fb", role: "top", targets: ["a", "b", "c"] });
    expect(M.player(sess.state, 0).board).toContain("fb"); // SS'd to YOUR board
    const mz = M.player(sess.state, 1).meldZone;
    expect(mz.length).toBe(1); // the forced meld lands in THEIR meld zone
    expect([...mz[0]!.cards].sort()).toEqual(["a", "b", "c"]);
    expect(M.player(sess.state, 1).board).toEqual([]); // their 3 characters left the board
    expect(M.player(sess.state, 1).hand.length).toBe(hand1); // no Faith draw
    expect(sess.state.faithDeck.length).toBe(faith0); // Faith deck untouched
  });

  it("top: a chosen non-meld combination is rejected even when a valid one exists", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("fb", "MJG-M19", { atk: 3, def: 1, value: 5 }));
        p("board", 1, mk("a", "", { value: 1 }));
        p("board", 1, mk("b", "", { value: 2 }));
        p("board", 1, mk("c", "", { value: 3 })); // a,b,c = 1-2-3
        p("board", 1, mk("d", "", { value: 9 }));
      }),
    );
    expect(sess.command(0, { do: "activate", iid: "fb", role: "top", targets: ["a", "b", "d"] }).ok).toBe(false); // 1,2,9
    expect(sess.command(0, { do: "activate", iid: "fb", role: "top", targets: ["a", "b", "c"] }).ok).toBe(true); // 1,2,3
  });

  it("top: not offered unless an opponent controls a meldable triple", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("fb", "MJG-M19", { atk: 3, def: 1, value: 5 }));
        p("board", 1, mk("a", "", { value: 1 }));
        p("board", 1, mk("b", "", { value: 1 })); // only 2 characters
      }),
    );
    expect(sess.viewFor(0).legal.some((x) => x.kind === "activate" && x.iid === "fb" && x.role === "top")).toBe(false);
  });

  it("bottom 'We Gottem': take all [Cunny] and [Shota] cards from the opponent's hand", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("fb", "MJG-M19", { atk: 3, def: 1, value: 5 }))));
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances,
        cunny: mk("cunny", "", { tribes: ["Cunny"] }),
        shota: mk("shota", "", { tribes: ["Shota"] }),
        other: mk("other", "", { tribes: ["Furry"] }),
      },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, hand: ["cunny", "shota", "other"] } : p)),
    });
    sess.command(0, { do: "activate", iid: "fb", role: "bottom", targets: ["1"] });
    // resolution pauses on the shown-hand popup: the controller sees the target's hand
    expect(sess.viewFor(0).choice?.revealOwner).toBe(1);
    expect(sess.viewFor(0).choice?.ack).toBe(true);
    expect(sess.state.handRevealedTo).toEqual(expect.arrayContaining([{ owner: 1, viewer: 0 }]));
    // the reveal is public: the cards are in the log (with values) BEFORE the confirm
    expect(sess.state.log.some((l) => l.startsWith("player 1 reveals"))).toBe(true);
    expect(M.player(sess.state, 0).hand).not.toContain("cunny"); // nothing taken pre-confirm
    sess.choose(0, { use: true }); // confirm — the grabs resolve
    expect(M.player(sess.state, 0).hand).toEqual(expect.arrayContaining(["cunny", "shota"])); // both taken
    expect(M.player(sess.state, 0).hand).not.toContain("other"); // non-matching left behind
    expect(M.player(sess.state, 1).hand).toEqual(["other"]);
    expect(sess.state.instances["fb"]?.tapped).toBe(true); // using the Active taps it
    expect(sess.state.handRevealedTo).toEqual([]); // hands are private again after resolution
  });

  it("bottom: negated (Koito) -> no reveal popup, no reveal log, nothing taken", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("fb", "MJG-M19", { atk: 3, def: 1, value: 5 }))));
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances,
        cunny: mk("cunny", "", { tribes: ["Cunny"] }),
        koit: mk("koit", "MJG-C31", { value: 1 }),
      },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, hand: ["cunny", "koit"] } : p)),
    });
    sess.setToggle(1, "auto");
    sess.command(0, { do: "activate", iid: "fb", role: "bottom", targets: ["1"] });
    expect(sess.awaiting).toBe(1); // Easily Startled offered to the revealing player
    sess.respond(1, { activate: { iid: "koit", role: "top" } });
    // the reveal effect is negated: no shown-hand popup, no reveal (state or log), no grab
    expect(sess.viewFor(0).choice).toBeFalsy();
    expect(sess.state.handRevealedTo).toEqual([]);
    expect(sess.state.log.some((l) => l.startsWith("player 1 reveals"))).toBe(false);
    expect(M.player(sess.state, 1).hand).toContain("cunny");
    expect(M.player(sess.state, 0).hand).not.toContain("cunny");
  });
});

describe("MJG-M21 The Jongker", () => {
  it("top 'BAAAANG': discard your whole hand, then the 10+-card opponent discards theirs", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `o${i}`);
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("jk", "MJG-M21", { atk: 0, def: 0, value: 8 }));
        p("hand", 0, mk("mine", "")); // another card in your hand
        for (const i of ten) p("hand", 1, mk(i, ""));
      }),
    );
    sess.command(0, { do: "activate", iid: "jk", role: "top", targets: ["1"] });
    expect(drainMass(sess)).toBeGreaterThan(0); // each player ordered their own discards
    expect(M.player(sess.state, 0).hand).toEqual([]); // your hand discarded (this card included)
    expect(M.player(sess.state, 1).hand).toEqual([]); // their hand discarded
    expect(sess.state.discard).toEqual(expect.arrayContaining(["jk", "mine", ...ten]));
  });

  it("top: the mass discard runs ONE BY ONE with a response window after each", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `o${i}`);
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("jk", "MJG-M21", { atk: 0, def: 0, value: 8 }));
        p("hand", 0, mk("mine", ""));
        for (const i of ten) p("hand", 1, mk(i, ""));
      }),
    );
    // seat 1 needs a LEGAL response to be awaited at windows ("always" still
    // skips seats with nothing playable) — a Banana (anytime) keeps them awake
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, bana: mk("bana", "MJG-013", { atk: 2, def: 2, value: 6 }) },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, hand: [...p.hand, "bana"] } : p)),
    });
    sess.setToggle(1, "auto"); // realistic setting: prompted only as a REACTION
    sess.command(0, { do: "activate", iid: "jk", role: "top", targets: ["1"] });
    let last = sess.state.discard.length;
    let steps = 0;
    for (let guard = 0; guard < 120; guard++) {
      // each card falls only when its owner CHOOSES it, then a window opens
      const chooser = sess.state.players.map((p) => p.pid).find((pid) => sess.viewFor(pid).choice?.massPick);
      if (chooser !== undefined) {
        sess.choose(chooser, { use: true, target: sess.viewFor(chooser).choice!.options[0]!.iid });
      } else if (sess.awaiting !== null) {
        sess.respond(sess.awaiting, { pass: true });
      } else break;
      steps++;
      const now = sess.state.discard.length;
      expect(now - last).toBeLessThanOrEqual(1); // never more than ONE discard per step
      last = now;
    }
    expect(steps).toBeGreaterThan(11); // a pick/window per queued card
    expect(M.player(sess.state, 0).hand).toEqual([]);
    expect(M.player(sess.state, 1).hand).toEqual([]);
    expect(sess.state.discard).toEqual(expect.arrayContaining(["jk", "mine", "bana", ...ten]));
  });

  it("top: not activatable unless an opponent has 10+ cards in hand", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `o${i}`);
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("jk", "MJG-M21", { atk: 0, def: 0, value: 8 }));
        for (const i of nine) p("hand", 1, mk(i, ""));
      }),
    );
    const offered = () => sess.viewFor(0).legal.some((x) => x.kind === "activate" && x.iid === "jk" && x.role === "top");
    expect(offered()).toBe(false); // only 9
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, o9: mk("o9") },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, hand: [...p.hand, "o9"] } : p)),
    });
    expect(offered()).toBe(true); // now 10
  });

  it("bottom 'Joker's Joke': each player draws 3, discards 2 random, gains a Clown counter", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("jk", "MJG-M21", { atk: 0, def: 0, value: 8 }))));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => ({ ...p, hand: [] })) }); // clean count
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "jk", role: "bottom" });
    expect(M.player(sess.state, 0).hand.length).toBe(1); // 0 + 3 - 2
    expect(M.player(sess.state, 1).hand.length).toBe(1);
    expect(M.player(sess.state, 0).counters.Clown).toBe(1);
    expect(M.player(sess.state, 1).counters.Clown).toBe(1);
    expect(sess.state.discard.length).toBe(4); // 2 discarded per player
    expect(sess.state.mainDeck.length).toBe(deck0 - 6); // 3 drawn per player
    expect(sess.state.instances["jk"]?.tapped).toBe(true); // using the Active taps it
  });
});

describe("MJG-M22 Majsoul Secret Room", () => {
  it("bottom 'Secret Rumors': set 2 face-down, the opponent blindly takes one; both flip up at their controller's next turn", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("msr", "MJG-M22", { atk: 0, def: 2, value: 2 }));
        p("hand", 0, mk("c1", ""));
        p("hand", 0, mk("c2", ""));
      }),
    );
    sess.command(0, { do: "activate", iid: "msr", role: "bottom", targets: ["1"] });
    // COST: place 2 hand cards face-down on your board (one at a time)
    sess.choose(0, { use: true, target: "c1" });
    sess.choose(0, { use: true, target: "c2" });
    expect(M.player(sess.state, 0).board).toEqual(expect.arrayContaining(["c1", "c2"]));
    expect(sess.state.instances["c1"]?.faceDown).toBe(true);
    expect(sess.state.instances["c2"]?.faceDown).toBe(true);
    expect(M.player(sess.state, 0).hand).not.toContain("c1"); // left the hand
    // the opponent blindly takes one — both options are face-down (can't look)
    const ch = sess.viewFor(1).choice;
    expect(ch?.options.map((o) => o.cardId)).toEqual([null, null]);
    sess.choose(1, { use: true, target: "c1" });
    expect(M.player(sess.state, 1).board).toContain("c1"); // moved to THEIR board
    expect(M.player(sess.state, 0).board).toContain("c2"); // the other stays with you
    expect(sess.state.instances["c1"]?.faceDown).toBe(true); // still hidden on their board
    // c1 flips up at the start of seat 1's next turn; c2 stays down (until seat 0's)
    sess.state = M.reduce(M.replace(sess.state, { activePlayer: 0, phase: M.Phase.TURN_END }), { type: M.ActionType.ADVANCE }); // -> seat 1
    expect(sess.state.instances["c1"]?.faceDown).toBe(false);
    expect(sess.state.instances["c2"]?.faceDown).toBe(true);
  });

  it("bottom: not activatable without 2 hand cards to place", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("msr", "MJG-M22", { atk: 0, def: 2, value: 2 }))));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["only"] } : p)), instances: { ...sess.state.instances, only: mk("only") } });
    expect(sess.viewFor(0).legal.some((x) => x.kind === "activate" && x.iid === "msr" && x.role === "bottom")).toBe(false);
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["only", "more"] } : p)), instances: { ...sess.state.instances, more: mk("more") } });
    expect(sess.viewFor(0).legal.some((x) => x.kind === "activate" && x.iid === "msr" && x.role === "bottom")).toBe(true);
  });
});

describe("MJG-M23 Elegant", () => {
  it("top 'Drop Trading': grab the top discard at the end of each OPPONENT's turn", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("el", "MJG-M23", { atk: 1, def: 1, value: 3 }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, d0: mk("d0") },
      discard: ["d0"],
      activePlayer: 1, // it's the opponent's turn
      phase: M.Phase.MAIN_PHASE,
    });
    sess.command(1, { do: "endTurn" });
    expect(M.player(sess.state, 0).hand).toContain("d0"); // seat 0 grabbed the top discard
    expect(sess.state.discard).not.toContain("d0");
  });

  it("top: does NOT fire at the end of the controller's own turn", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("el", "MJG-M23", { atk: 1, def: 1, value: 3 }))));
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, d0: mk("d0") }, discard: ["d0"] });
    sess.command(0, { do: "endTurn" }); // seat 0's own turn ends
    expect(M.player(sess.state, 0).hand).not.toContain("d0");
    expect(sess.state.discard).toContain("d0");
  });

  it("bottom 'Buying gf': give 2 hand cards to the owner and take control of their FEMALE character", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("el", "MJG-M23", { atk: 1, def: 1, value: 3 }));
        p("hand", 0, mk("g1", ""));
        p("hand", 0, mk("g2", ""));
        p("board", 1, mk("she", "MJG-001", { atk: 2, def: 2, value: 1 })); // MJG-001 is FEMALE
      }),
    );
    sess.command(0, { do: "activate", iid: "el", role: "bottom", targets: ["she"] });
    sess.choose(0, { use: true, target: "g1" });
    sess.choose(0, { use: true, target: "g2" });
    expect(M.player(sess.state, 0).board).toContain("she"); // taken to your board
    expect(M.player(sess.state, 1).board).not.toContain("she");
    expect(M.player(sess.state, 1).hand).toEqual(expect.arrayContaining(["g1", "g2"])); // 2 cards given to the owner
    expect(M.player(sess.state, 0).hand).not.toContain("g1");
    expect(sess.state.instances["el"]?.tapped).toBe(true); // using the Active taps it
  });

  it("bottom: only a FEMALE opponent character is a legal target", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("el", "MJG-M23", { atk: 1, def: 1, value: 3 }));
        p("hand", 0, mk("g1", ""));
        p("hand", 0, mk("g2", ""));
        p("board", 1, mk("she", "MJG-001")); // FEMALE
        p("board", 1, mk("him", "MJG-M21")); // MALE
      }),
    );
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "el" && a.role === "bottom") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetIds).toEqual(["she"]); // only the FEMALE
  });
});

describe("MJG-HAT — FU-FU-FUCK SHAMIKO", () => {
  it("top 'keikumusume': negate an opponent's meld that uses the discard top and steal that card", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("a", "", { value: 5 }));
        p("board", 0, mk("b", "", { value: 5 }));
        p("hand", 1, mk("hat", "MJG-HAT", { atk: 2, def: 2, value: 4 }));
      }),
    );
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, d5: mk("d5", "", { value: 5 }) }, discard: ["d5"] });
    sess.setToggle(1, "auto");
    sess.command(0, { do: "meld", materials: ["a", "b", "d5"] }); // a 5-5-5 meld using the discard top
    expect(sess.awaiting).toBe(1); // seat 1 may respond
    sess.respond(1, { activate: { iid: "hat", role: "top" } });
    // the meld is negated: seat 0 gets no meld; a + b stay on their board
    expect(M.player(sess.state, 0).meldZone.length).toBe(0);
    expect(M.player(sess.state, 0).board).toEqual(expect.arrayContaining(["a", "b"]));
    // this card is Special Summoned, and the discard material is stolen — both to seat 1
    expect(M.player(sess.state, 1).board).toEqual(expect.arrayContaining(["hat", "d5"]));
    expect(sess.state.discard).not.toContain("d5");
    expect(M.player(sess.state, 0).meldedThisTurn).toBe(true); // a negated Normal Meld is "used up"
  });

  it("top: not offered against a hand-only meld (no discard card used)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("a", "", { value: 5 }));
        p("board", 0, mk("b", "", { value: 5 }));
        p("board", 0, mk("c", "", { value: 5 }));
        p("hand", 1, mk("hat", "MJG-HAT", { atk: 2, def: 2, value: 4 }));
      }),
    );
    sess.setToggle(1, "always");
    sess.command(0, { do: "meld", materials: ["a", "b", "c"] }); // pure board meld, no discard
    // seat 1 has no legal response (the meld uses no discard card) -> not awaited
    expect(sess.awaiting).toBeNull();
    expect(M.player(sess.state, 0).meldZone.length).toBe(1); // the meld resolved
  });
});

describe("SOA-C02 Temeraire", () => {
  it("top 'Breast Expansion': discard this card, then draw 2 — or draw up to 5", () => {
    // "draw 2" mode
    const a = new GameSession(setup((p) => p("hand", 0, mk("t", "SOA-C02", { atk: 2, def: 5, value: 5 }))));
    a.state = M.replace(a.state, { players: a.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["t"] } : p)) });
    const deckA = a.state.mainDeck.length;
    a.command(0, { do: "activate", iid: "t", role: "top" });
    expect(a.state.discard).toContain("t"); // step 0 discarded this card
    expect(a.viewFor(0).choice).not.toBeNull(); // step 1 prompts the draw mode
    a.choose(0, { use: true, target: "two" });
    expect(M.player(a.state, 0).hand.length).toBe(2);
    expect(a.state.mainDeck.length).toBe(deckA - 2);

    // "draw until 5" mode — after discarding the source, a 2-card hand fills to 5
    const b = new GameSession(setup((p) => p("hand", 0, mk("t", "SOA-C02", { atk: 2, def: 5, value: 5 }))));
    b.state = M.replace(b.state, {
      instances: { ...b.state.instances, k1: mk("k1"), k2: mk("k2") },
      players: b.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["t", "k1", "k2"] } : p)),
    });
    b.command(0, { do: "activate", iid: "t", role: "top" });
    b.choose(0, { use: true, target: "fill" });
    expect(M.player(b.state, 0).hand.length).toBe(5); // 2 left after the discard -> draw 3
  });

  it("bottom 'SOA': an opponent cannot target your cards", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("soa", "SOA-C02", { atk: 2, def: 5, value: 5 }));
        p("board", 0, mk("ally", "", { atk: 3, def: 3 }));
        p("board", 1, mk("rab", "MJG-018", { atk: 1, def: 1 })); // Mr Rabbit — target ANY character
      }),
    );
    sess.state = M.replace(sess.state, { activePlayer: 1, phase: M.Phase.MAIN_PHASE });
    const act = sess.viewFor(1).legal.find((a) => a.kind === "activate" && a.iid === "rab" && a.role === "bottom") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetIds).toEqual(["rab"]); // only seat 1's own card; seat 0's are untargetable
  });

  it("bottom: an opponent cannot target the SOA player as an opponent-target", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("soa", "SOA-C02", { atk: 2, def: 5, value: 5 }));
        p("board", 1, mk("dnk", "MJG-006")); // Dnruk "SEX" — target an opponent
      }),
    );
    sess.state = M.replace(sess.state, { activePlayer: 1, phase: M.Phase.MAIN_PHASE });
    // the only opponent (seat 0) is SOA-protected -> no legal opponent target -> not offered
    expect(sess.viewFor(1).legal.some((a) => a.kind === "activate" && a.iid === "dnk" && a.role === "bottom")).toBe(false);
  });

  it("bottom: SOA only blocks OPPONENT effects — your own still work", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("soa", "SOA-C02", { atk: 2, def: 5, value: 5 }));
        p("board", 0, mk("rab", "MJG-018", { atk: 1, def: 1 })); // your own Mr Rabbit
        p("board", 0, mk("ally", "", { atk: 3, def: 3 }));
      }),
    );
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "rab" && a.role === "bottom") as Extract<LA, { kind: "activate" }> | undefined;
    expect(act?.targetIds).toEqual(expect.arrayContaining(["rab", "ally", "soa"])); // self-targeting unaffected
    // unit level: an opponent's effect no-ops on your cards; your own applies
    const s = setup((p) => {
      p("board", 0, mk("soa", "SOA-C02", { atk: 2, def: 5, value: 5 }));
      p("board", 0, mk("mine", "", { atk: 3, def: 3 }));
    });
    const own = applyIntent(s, { kind: "statMod", iid: "mine", stat: "atk", op: "add", amount: 5, duration: "persistent" }, 0).state;
    expect(M.atkOf(own, "mine")).toBe(8); // your own effect works
    const opp = applyIntent(s, { kind: "statMod", iid: "mine", stat: "atk", op: "add", amount: 5, duration: "persistent" }, 1).state;
    expect(M.atkOf(opp, "mine")).toBe(3); // an opponent's effect no-ops
  });

  it("bottom: a board wipe / mass effect from an opponent does NOT hit your cards", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("soa", "SOA-C02", { atk: 2, def: 5, value: 5 }));
        p("board", 0, mk("ally", "", { atk: 3, def: 3 }));
        p("board", 1, mk("idol", "MJG-008", { atk: 1, def: 1 })); // "A Black Hole?" — each player discards all face-up
      }),
    );
    sess.state = M.replace(sess.state, { activePlayer: 1, phase: M.Phase.MAIN_PHASE });
    sess.command(1, { do: "activate", iid: "idol", role: "bottom" });
    // the SOA player's board is untouched by the opponent's board wipe
    expect(M.player(sess.state, 0).board).toEqual(["soa", "ally"]);
    expect(sess.state.discard).not.toContain("soa");
    expect(sess.state.discard).not.toContain("ally");
    // the activator's OWN board is still wiped (their own effect on their own card)
    sess.command(1, { do: "discard", iid: "idol" });
    expect(sess.state.discard).toContain("idol");
  });
});

describe("MJG-C03 amaekoromo", () => {
  it("bottom 'Haitei Raoyue': draw the bottom card, then optionally meld it with board/discard cards", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("koro", "MJG-C03", { atk: 1, def: 3, value: 5 })); // value 5 -> not a meld material here
        p("board", 0, mk("b2", "", { value: 2 }));
        p("board", 0, mk("b3", "", { value: 3 }));
      }),
    );
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, d1: mk("d1", "", { value: 1 }) },
      mainDeck: [...sess.state.mainDeck, "d1"], // bottom of the deck
    });
    sess.command(0, { do: "activate", iid: "koro", role: "bottom" });
    expect(M.player(sess.state, 0).hand).toContain("d1"); // revealed + drawn (about to be melded)
    // the reveal is logged with the card's VALUE in brackets (standard reveal format)
    expect(sess.state.log.some((l) => l.includes("reveals and draws") && l.includes("(1)"))).toBe(true);
    sess.choose(0, { use: true }); // make the Special Meld
    sess.choose(0, { use: true, target: "b2" });
    sess.choose(0, { use: true, target: "b3" });
    const mz = M.player(sess.state, 0).meldZone;
    expect(mz.length).toBe(1);
    expect([...mz[0]!.cards].sort()).toEqual(["b2", "b3", "d1"]); // 1-2-3 from hand + board
    expect(mz[0]!.kind).toBe("sequence");
    expect(M.player(sess.state, 0).hand).not.toContain("d1"); // the drawn card left the hand into the meld
    expect(M.player(sess.state, 0).board).not.toContain("b2");
  });

  it("bottom: you keep the drawn card when no meld is possible (or you decline)", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("koro", "MJG-C03", { atk: 1, def: 3, value: 5 }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, d1: mk("d1", "", { value: 1 }) },
      mainDeck: [...sess.state.mainDeck, "d1"],
    });
    sess.command(0, { do: "activate", iid: "koro", role: "bottom" });
    expect(M.player(sess.state, 0).hand).toContain("d1"); // still drawn (the guaranteed half)
    expect(M.player(sess.state, 0).meldZone.length).toBe(0); // no board cards to complete a meld
  });
});

describe("MJG-C04 All My Mahjong Friends Have Died", () => {
  it("top 'Shoumakyou': while the lock is up, opponents of the locker can't activate effects", () => {
    const sess = new GameSession(setup((p) => p("board", 1, mk("ny", "MJG-001", { atk: 2, def: 2 }))));
    sess.state = M.replace(sess.state, { activePlayer: 1, phase: M.Phase.MAIN_PHASE });
    const offered = () => sess.viewFor(1).legal.some((a) => a.kind === "activate" && a.iid === "ny");
    expect(offered()).toBe(true); // baseline
    sess.state = M.replace(sess.state, { effectLockBy: 0 }); // locked by seat 0
    expect(offered()).toBe(false); // seat 1 (opponent) is locked out
    sess.state = M.replace(sess.state, { effectLockBy: 1 }); // locked by seat 1
    expect(offered()).toBe(true); // the locker themselves is unaffected
  });

  it("top: activate after an opponent resolves an effect -> opponents are locked for the turn", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("ny", "MJG-001", { atk: 2, def: 2 })); // seat 0's Active (used to act)
        p("board", 0, mk("ny2", "MJG-001", { atk: 2, def: 2 })); // a second, untapped Active
        p("hand", 1, mk("teru", "MJG-C04", { atk: 5, def: 2, value: 5 }));
      }),
    );
    sess.setToggle(1, "always");
    sess.command(0, { do: "activate", iid: "ny", role: "bottom" }); // seat 0 resolves an effect
    expect(sess.awaiting).toBe(1); // seat 1 may respond (post-resolution window)
    sess.respond(1, { activate: { iid: "teru", role: "top" } });
    expect(sess.state.discard).toContain("teru"); // discarded as the cost
    expect(sess.state.effectLockBy).toBe(1);
    // seat 0's still-untapped Active is now locked out
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "ny2")).toBe(false);
  });

  it("bottom 'Winning Streak': after you meld, draw 1 per meld you have", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("teru", "MJG-C04", { atk: 5, def: 2, value: 5 }));
        p("board", 0, mk("m1", "", { value: 7 }));
        p("board", 0, mk("m2", "", { value: 7 }));
        p("board", 0, mk("m3", "", { value: 7 }));
      }),
    );
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "meld", materials: ["m1", "m2", "m3"] });
    expect(M.player(sess.state, 0).meldZone.length).toBe(1);
    expect(sess.state.mainDeck.length).toBe(deck0 - 1); // drew 1 (1 meld)
  });

  it("bottom: 2 melds -> draw 2; and it does NOT fire when this card is itself a material", () => {
    const dummy = { cards: ["x"], kind: "triplet" as const, kan: false };
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("teru", "MJG-C04", { atk: 5, def: 2, value: 5 }));
        p("board", 0, mk("m1", "", { value: 7 }));
        p("board", 0, mk("m2", "", { value: 7 }));
        p("board", 0, mk("m3", "", { value: 7 }));
      }),
    );
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, meldZone: [dummy] } : p)) });
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "meld", materials: ["m1", "m2", "m3"] });
    expect(M.player(sess.state, 0).meldZone.length).toBe(2);
    expect(sess.state.mainDeck.length).toBe(deck0 - 2); // drew 2 (2 melds)

    // when this card is a meld material it leaves the board -> Winning Streak does not fire
    const s2 = new GameSession(
      setup((p) => {
        p("board", 0, mk("teru", "MJG-C04", { atk: 5, def: 2, value: 5 }));
        p("board", 0, mk("f1", "", { value: 5 }));
        p("board", 0, mk("f2", "", { value: 5 }));
      }),
    );
    const d2 = s2.state.mainDeck.length;
    s2.command(0, { do: "meld", materials: ["teru", "f1", "f2"] }); // 5-5-5 using teru itself
    expect(M.player(s2.state, 0).meldZone.length).toBe(1);
    expect(s2.state.mainDeck.length).toBe(d2); // no Winning Streak draw
  });
});

describe("MJG-C05 i can't believe toki is fucking dead", () => {
  it("bottom 'Futuristic Player': add 1 of the top 3 to hand (the other 2 stay in order), lose 1 DEF", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("toki", "MJG-C05", { atk: 3, def: 3, value: 3 }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, t0: mk("t0"), t1: mk("t1"), t2: mk("t2") },
      mainDeck: ["t0", "t1", "t2", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "toki", role: "bottom" });
    expect(sess.viewFor(0).choice?.options.map((o) => o.iid)).toEqual(["t0", "t1", "t2"]); // looks at the top 3
    expect(sess.viewFor(1).choice).toBeNull(); // the look is private to the controller
    sess.choose(0, { use: true, target: "t1" }); // take the middle one
    expect(M.player(sess.state, 0).hand).toContain("t1");
    expect(sess.state.mainDeck.slice(0, 2)).toEqual(["t0", "t2"]); // the other two stay on top in order
    expect(M.defOf(sess.state, "toki")).toBe(2); // 3 -> 2
  });

  it("top 'Ryuuka Thighnergy': at 0 DEF the card is discarded", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("toki", "MJG-C05", { atk: 3, def: 1, value: 3 })))); // 1 DEF -> 1 use to 0
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, t0: mk("t0") },
      mainDeck: ["t0", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "toki", role: "bottom" });
    sess.choose(0, { use: true, target: "t0" }); // DEF 1 -> 0 -> the top passive discards it
    expect(M.player(sess.state, 0).board).not.toContain("toki");
    expect(sess.state.discard).toContain("toki");
  });
});

describe("MJG-C06 Copebots", () => {
  it("top 'Call Slut': meld an opponent's discard + this card + a completer", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("noose", "MJG-M09", { atk: 1, def: 0, value: 1 })); // seat 0 discards this (Tie the Noose)
        p("board", 1, mk("cope", "MJG-C06", { atk: 3, def: 3, value: 3 }));
        p("board", 1, mk("c2", "", { value: 2 })); // the completer
      }),
    );
    sess.setToggle(1, "auto"); // Call Slut is a reactive optional trigger
    sess.command(0, { do: "activate", iid: "noose", role: "top" }); // discard noose on seat 0's turn
    expect(sess.viewFor(1).choice).not.toBeNull(); // seat 1 offered Call Slut
    sess.choose(1, { use: true }); // accept the trigger
    expect(sess.viewFor(1).choice).not.toBeNull(); // pick the completer
    sess.choose(1, { use: true, target: "c2" });
    const mz = M.player(sess.state, 1).meldZone;
    expect(mz.length).toBe(1);
    expect([...mz[0]!.cards].sort()).toEqual(["c2", "cope", "noose"]); // 1-2-3 from discard + board
    expect(mz[0]!.kind).toBe("sequence");
  });

  it("bottom 'Log Review': reveal the top — give it to an opponent if it could meld with 2 board cards", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("cope", "MJG-C06", { atk: 3, def: 3, value: 3 }));
        p("board", 0, mk("a", "", { value: 1 }));
        p("board", 0, mk("b", "", { value: 2 }));
      }),
    );
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, T: mk("T", "", { value: 3 }) },
      mainDeck: ["T", ...sess.state.mainDeck], // a VALUE-3 top completes 1-2-3 with a,b
    });
    sess.command(0, { do: "activate", iid: "cope", role: "bottom" });
    expect(M.player(sess.state, 1).hand).toContain("T"); // given to the opponent
    expect(M.player(sess.state, 0).hand).not.toContain("T");
  });

  it("bottom: if it couldn't meld with 2 board cards, you draw the revealed card", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("cope", "MJG-C06", { atk: 3, def: 3, value: 3 }));
        p("board", 0, mk("a", "", { value: 1 }));
      }),
    );
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, T: mk("T", "", { value: 9 }) },
      mainDeck: ["T", ...sess.state.mainDeck], // VALUE-9: no meld with cope(3)+a(1)
    });
    sess.command(0, { do: "activate", iid: "cope", role: "bottom" });
    expect(M.player(sess.state, 0).hand).toContain("T"); // drew it instead
    expect(M.player(sess.state, 1).hand).not.toContain("T");
  });
});

describe("MJG-C07 ywnbaw7", () => {
  it("top 'Mihoko x Hisa <3': SS-able only while \"What are the odds...\" (MJG-C08) is on a board", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("kyap", "MJG-C07", { atk: 3, def: 4, value: 7 }))));
    const offered = () => sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "kyap" && a.role === "top");
    expect(offered()).toBe(false); // no MJG-C08 anywhere
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, odds: mk("odds", "MJG-C08") },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, board: [...p.board, "odds"] } : p)),
    });
    expect(offered()).toBe(true);
    sess.command(0, { do: "activate", iid: "kyap", role: "top" });
    expect(M.player(sess.state, 0).board).toContain("kyap");
  });

  it("bottom 'Diabolus ex Machina': draw the whole deck, then shuffle your hand back at end of turn", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("kyap", "MJG-C07", { atk: 3, def: 4, value: 7 }))));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: [] } : p)) }); // only this card, empty hand
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "kyap", role: "bottom" });
    expect(M.player(sess.state, 0).hand.length).toBe(deck0); // drew the entire deck
    expect(sess.state.mainDeck.length).toBe(0);
    sess.command(0, { do: "endTurn" });
    expect(M.player(sess.state, 0).hand.length).toBe(0); // hand shuffled back...
    expect(sess.state.mainDeck.length).toBe(deck0); // ...into the deck
  });

  it("bottom: not activatable unless this is your only board card AND your hand is empty", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("kyap", "MJG-C07", { atk: 3, def: 4, value: 7 }))));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["h"] } : p)), instances: { ...sess.state.instances, h: mk("h") } });
    const offered = () => sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "kyap" && a.role === "bottom");
    expect(offered()).toBe(false); // hand not empty
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: [], board: [...p.board, "extra"] } : p)), instances: { ...sess.state.instances, extra: mk("extra") } });
    expect(offered()).toBe(false); // not the only board card
  });
});

describe("MJG-C08 What are the odds...", () => {
  it("top 'Hisa x Mako <3': SS-able only while \"ywnbaw7\" (MJG-C07) is on a board", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("hisa", "MJG-C08", { atk: 3, def: 4, value: 1 }))));
    const offered = () => sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "hisa" && a.role === "top");
    expect(offered()).toBe(false); // no ywnbaw7
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, kyap: mk("kyap", "MJG-C07") },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, board: [...p.board, "kyap"] } : p)),
    });
    expect(offered()).toBe(true);
    sess.command(0, { do: "activate", iid: "hisa", role: "top" });
    expect(M.player(sess.state, 0).board).toContain("hisa");
  });

  it("bottom 'Deus ex Machina': win the game (only board card, empty hand)", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("hisa", "MJG-C08", { atk: 3, def: 4, value: 1 }))));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: [] } : p)) });
    sess.command(0, { do: "activate", iid: "hisa", role: "bottom" });
    expect(sess.state.winner).toBe(0);
    expect(sess.state.phase).toBe(M.Phase.GAME_OVER);
  });

  it("bottom: not activatable unless this is your only board card and your hand is empty", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("hisa", "MJG-C08", { atk: 3, def: 4, value: 1 }))));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["h"] } : p)), instances: { ...sess.state.instances, h: mk("h") } });
    const offered = () => sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "hisa" && a.role === "bottom");
    expect(offered()).toBe(false); // hand not empty
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: [], board: [...p.board, "x"] } : p)), instances: { ...sess.state.instances, x: mk("x") } });
    expect(offered()).toBe(false); // not the only board card
  });
});

describe("MJG-C09 i stab inside ichihime nya", () => {
  // single-card hands make the random reveal deterministic
  const gamble = (myVal: number, theirVal: number) => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("yume", "MJG-C09", { atk: 4, def: 1, value: 4, tribes: ["Schizo"] }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, mine: mk("mine", "", { value: myVal }), theirs: mk("theirs", "", { value: theirVal }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["mine"] } : { ...p, hand: ["theirs"] })),
    });
    sess.command(0, { do: "activate", iid: "yume", role: "bottom", targets: ["1"] });
    return sess;
  };

  it("bottom 'Honest Gamble': the lower-VALUE revealer discards their card", () => {
    const a = gamble(2, 8); // you revealed the lower -> you discard
    expect(a.state.discard).toContain("mine");
    expect(a.state.discard).not.toContain("theirs");
    const b = gamble(9, 1); // opponent revealed the lower -> they discard
    expect(b.state.discard).toContain("theirs");
    expect(b.state.discard).not.toContain("mine");
  });

  it("bottom: a tie discards nothing", () => {
    const t = gamble(5, 5);
    expect(t.state.discard).not.toContain("mine");
    expect(t.state.discard).not.toContain("theirs");
  });
});

describe("MJG-C10 MARY", () => {
  // single-card hands make the random reveal deterministic
  const gamble = (myVal: number, theirVal: number) => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("mary", "MJG-C10", { atk: 2, def: 2, value: 2, tribes: ["Schizo"] }))));
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, mine: mk("mine", "", { value: myVal }), theirs: mk("theirs", "", { value: theirVal }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["mine"] } : { ...p, hand: ["theirs"] })),
    });
    const deck = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "mary", role: "bottom", targets: ["1"] });
    return { sess, deck };
  };

  it("bottom 'Honester Gamble': the higher-VALUE revealer draws 2", () => {
    const a = gamble(8, 2); // you revealed higher -> you draw 2
    expect(M.player(a.sess.state, 0).hand.length).toBe(3); // mine + 2 drawn
    expect(M.player(a.sess.state, 1).hand.length).toBe(1); // theirs only
    expect(a.sess.state.mainDeck.length).toBe(a.deck - 2);

    const b = gamble(2, 8); // opponent revealed higher -> they draw 2
    expect(M.player(b.sess.state, 1).hand.length).toBe(3);
    expect(M.player(b.sess.state, 0).hand.length).toBe(1);
    expect(b.sess.state.mainDeck.length).toBe(b.deck - 2);
  });

  it("bottom: a tie draws nothing", () => {
    const t = gamble(5, 5);
    expect(M.player(t.sess.state, 0).hand.length).toBe(1);
    expect(M.player(t.sess.state, 1).hand.length).toBe(1);
    expect(t.sess.state.mainDeck.length).toBe(t.deck);
  });

  it("top 'Literary Club': a player with no [Schizo] must discard 1 card to attack", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 9, def: 9 })); // active attacker, controls no [Schizo]
        p("board", 1, mk("def", "", { atk: 1, def: 1 })); // defender
        p("board", 1, mk("mary", "MJG-C10", { value: 2, tribes: ["Schizo"] })); // Literary Club in play
      }),
    );
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, h0: mk("h0") },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["h0"] } : p)),
    });
    const r = sess.command(0, { do: "attack", attacker: "att", target: "def" });
    expect(r.ok).toBe(true);
    // paused for the discard cost — the attack hasn't happened yet
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-C10:top");
    expect(M.player(sess.state, 1).board).toContain("def");
    sess.choose(0, { use: true, target: "h0" }); // pay the cost
    expect(sess.state.discard).toContain("h0"); // discarded to attack
    expect(sess.state.discard).toContain("def"); // 9/9 then beats 1/1
    expect(M.player(sess.state, 0).board).toContain("att");
  });

  it("top: controlling a [Schizo] exempts you from the discard cost", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 9, def: 9 }));
        p("board", 0, mk("mary", "MJG-C10", { value: 2, tribes: ["Schizo"] })); // you control a [Schizo]
        p("board", 1, mk("def", "", { atk: 1, def: 1 }));
      }),
    );
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, h0: mk("h0") },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["h0"] } : p)),
    });
    sess.command(0, { do: "attack", attacker: "att", target: "def" });
    expect(sess.viewFor(0).choice).toBeNull(); // no cost prompt
    expect(M.player(sess.state, 0).hand).toContain("h0"); // nothing discarded
    expect(sess.state.discard).toContain("def"); // attack went straight through
  });

  it("top: with no [Schizo] and an empty hand, attacking is illegal (cost unpayable)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 9, def: 9 }));
        p("board", 1, mk("def", "", { atk: 1, def: 1 }));
        p("board", 1, mk("mary", "MJG-C10", { value: 2, tribes: ["Schizo"] }));
      }),
    );
    sess.state = M.replace(sess.state, {
      events: [],
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: [] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "attack" && a.iid === "att")).toBe(false);
    expect(sess.command(0, { do: "attack", attacker: "att", target: "def" }).ok).toBe(false);
  });
});

describe("MJG-C11 KIRA", () => {
  // multi-card hands so the CHOICE of which card to reveal is meaningful
  const gamble = (oppPick: string, myPick: string) => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("kira", "MJG-C11", { atk: 4, def: 1, value: 4, tribes: ["Schizo"] }))));
    sess.state = M.replace(sess.state, {
      events: [],
      instances: {
        ...sess.state.instances,
        m_hi: mk("m_hi", "", { value: 9 }), m_lo: mk("m_lo", "", { value: 1 }), m_mid: mk("m_mid", "", { value: 5 }),
        o_hi: mk("o_hi", "", { value: 8 }), o_lo: mk("o_lo", "", { value: 2 }), o_mid: mk("o_mid", "", { value: 5 }),
      },
      players: sess.state.players.map((p) =>
        p.pid === 0 ? { ...p, hand: ["m_hi", "m_lo", "m_mid"] } : { ...p, hand: ["o_hi", "o_lo", "o_mid"] }),
    });
    sess.command(0, { do: "activate", iid: "kira", role: "bottom", targets: ["1"] });
    sess.choose(1, { use: true, target: oppPick }); // opponent chooses first
    sess.choose(0, { use: true, target: myPick }); // then the activator
    return sess;
  };

  it("bottom 'Honestest Gamble': each player chooses a reveal; the lower VALUE discards it", () => {
    const a = gamble("o_hi", "m_lo"); // theirs 8 vs mine 1 -> I discard m_lo
    expect(a.state.discard).toContain("m_lo");
    expect(a.state.discard).not.toContain("o_hi");

    const b = gamble("o_lo", "m_hi"); // theirs 2 vs mine 9 -> they discard o_lo
    expect(b.state.discard).toContain("o_lo");
    expect(b.state.discard).not.toContain("m_hi");
  });

  it("bottom: a tie discards nothing", () => {
    const t = gamble("o_mid", "m_mid"); // 5 vs 5
    expect(t.state.discard).not.toContain("o_mid");
    expect(t.state.discard).not.toContain("m_mid");
  });

  it("bottom: the opponent is prompted to choose first, then the activator", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("kira", "MJG-C11", { atk: 4, def: 1, value: 4, tribes: ["Schizo"] }))));
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, mine: mk("mine", "", { value: 3 }), theirs: mk("theirs", "", { value: 7 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["mine"] } : { ...p, hand: ["theirs"] })),
    });
    sess.command(0, { do: "activate", iid: "kira", role: "bottom", targets: ["1"] });
    expect(sess.viewFor(1).choice?.effectId).toBe("MJG-C11:bottom"); // opponent first
    expect(sess.viewFor(0).choice).toBeNull();
    sess.choose(1, { use: true, target: "theirs" });
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-C11:bottom"); // then the activator
    sess.choose(0, { use: true, target: "mine" });
    expect(sess.state.discard).toContain("mine"); // 3 < 7 -> I discard
  });
});

describe("MJG-C12 MIDA", () => {
  it("top 'Beautification Council': every player discards floor(hand/2), controller first", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("mida", "MJG-C12", { atk: 5, def: 0, value: 5, tribes: ["Schizo"] }))));
    sess.state = M.replace(sess.state, {
      events: [],
      instances: {
        ...sess.state.instances,
        a0: mk("a0"), a1: mk("a1"), a2: mk("a2"), a3: mk("a3"), a4: mk("a4"),
        b0: mk("b0"), b1: mk("b1"), b2: mk("b2"),
      },
      players: sess.state.players.map((p) =>
        p.pid === 0 ? { ...p, hand: ["a0", "a1", "a2", "a3", "a4"] } : { ...p, hand: ["b0", "b1", "b2"] }),
    });
    sess.command(0, { do: "activate", iid: "mida", role: "top" });
    // controller (seat 0) is prompted first: 5 -> discard 2
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-C12:top");
    sess.choose(0, { use: true, target: "a0" });
    sess.choose(0, { use: true, target: "a1" });
    // then seat 1: 3 -> discard 1
    expect(sess.viewFor(1).choice?.effectId).toBe("MJG-C12:top");
    sess.choose(1, { use: true, target: "b0" });
    expect(M.player(sess.state, 0).hand.length).toBe(3); // 5 - 2
    expect(M.player(sess.state, 1).hand.length).toBe(2); // 3 - 1
    expect(sess.state.discard).toEqual(expect.arrayContaining(["a0", "a1", "b0"]));
  });

  it("top: an SOA-protected player (Temeraire) is exempt from the discard", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("mida", "MJG-C12", { atk: 5, def: 0, value: 5, tribes: ["Schizo"] }));
        p("board", 1, mk("soa", "SOA-C02")); // seat 1 is immune to opponent effects
      }),
    );
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, a0: mk("a0"), a1: mk("a1"), a2: mk("a2"), a3: mk("a3"), b0: mk("b0"), b1: mk("b1"), b2: mk("b2"), b3: mk("b3") },
      players: sess.state.players.map((p) =>
        p.pid === 0 ? { ...p, hand: ["a0", "a1", "a2", "a3"] } : { ...p, hand: ["b0", "b1", "b2", "b3"] }),
    });
    sess.command(0, { do: "activate", iid: "mida", role: "top" });
    sess.choose(0, { use: true, target: "a0" }); // seat 0 discards 2 (floor 4/2)
    sess.choose(0, { use: true, target: "a1" });
    expect(M.player(sess.state, 0).hand.length).toBe(2); // 4 - 2
    expect(M.player(sess.state, 1).hand.length).toBe(4); // exempt: untouched
    expect(sess.viewFor(1).choice).toBeNull(); // never prompted
  });

  // same-VALUE hands make the random reveal's OUTCOME deterministic
  const dbl = (myVal: number, theirVal: number, myCount: number) => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("mida", "MJG-C12", { atk: 5, def: 0, value: 5, tribes: ["Schizo"] }))));
    const myHand = Array.from({ length: myCount }, (_, i) => `m${i}`);
    const insts: Record<string, M.CardInstance> = {};
    for (const iid of myHand) insts[iid] = mk(iid, "", { value: myVal });
    insts["o0"] = mk("o0", "", { value: theirVal });
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, ...insts },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: myHand } : { ...p, hand: ["o0"] })),
    });
    const deck = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "mida", role: "bottom", targets: ["1"] });
    drainMass(sess); // the loser orders their own hand discard
    return { sess, deck };
  };

  it("bottom 'Double or Nothing': revealing the LOWER VALUE discards your entire hand", () => {
    const r = dbl(1, 9, 3); // mine 1 < theirs 9
    expect(M.player(r.sess.state, 0).hand.length).toBe(0);
    expect(r.sess.state.discard).toEqual(expect.arrayContaining(["m0", "m1", "m2"]));
    expect(M.player(r.sess.state, 1).hand).toContain("o0"); // opponent untouched
  });

  it("bottom: revealing the higher VALUE draws cards equal to your hand size", () => {
    const r = dbl(9, 1, 3); // mine 9 > theirs 1 -> draw 3
    expect(M.player(r.sess.state, 0).hand.length).toBe(6); // 3 + 3
    expect(r.sess.state.mainDeck.length).toBe(r.deck - 3);
  });

  it("bottom: a tie counts as NOT-lower, so you draw (double up)", () => {
    const r = dbl(5, 5, 2); // tie -> else branch -> draw 2
    expect(M.player(r.sess.state, 0).hand.length).toBe(4); // 2 + 2
    expect(r.sess.state.mainDeck.length).toBe(r.deck - 2);
  });
});

describe("MJG-C15 KAGY — Book of Eclipse", () => {
  it("bottom: face-down cards do NOT flip back up while KAGY is on board", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("bn", "BAK-YOU"));
        p("board", 0, mk("kagy", "MJG-C15", { atk: 1, def: 5, value: 5 })); // Book of Eclipse
        p("board", 1, mk("vic", "", { atk: 3, def: 3, value: 7 }));
      }),
    );
    sess.command(0, { do: "summon", iid: "bn" });
    sess.choose(0, { use: true, target: "vic" }); // BAK-YOU flips vic face-down
    expect(sess.state.instances["vic"]?.faceDown).toBe(true);
    expect(sess.state.eclipseActive).toBe(true);
    // advance to the flipper's next turn — normally vic would flip back up here
    sess.state = M.reduce(M.replace(sess.state, { phase: M.Phase.TURN_END }), { type: M.ActionType.ADVANCE });
    sess.state = M.reduce(M.replace(sess.state, { phase: M.Phase.TURN_END }), { type: M.ActionType.ADVANCE });
    expect(sess.state.instances["vic"]?.faceDown).toBe(true); // still down — Book of Eclipse suppresses it
  });

  it("bottom: when KAGY leaves play, all face-down characters immediately flip face-up", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 9, def: 9 })); // active attacker
        p("board", 1, mk("kagy", "MJG-C15", { atk: 1, def: 5, value: 5 })); // 5 DEF — will lose
        p("board", 1, mk("fd", "", { faceDown: true, value: 2 })); // a hidden character
      }),
    );
    // KAGY has been in play, so the latch is up (any reduce keeps it in sync)
    sess.state = M.replace(sess.state, { eclipseActive: true });
    sess.command(0, { do: "attack", attacker: "att", target: "kagy" }); // 9 ATK > 5 DEF -> KAGY discarded
    expect(M.player(sess.state, 1).board).not.toContain("kagy");
    expect(sess.state.eclipseActive).toBe(false);
    expect(sess.state.instances["fd"]?.faceDown).toBe(false); // flipped face-up as KAGY left
  });
});

describe("MJG-C17 KEIS", () => {
  const meld = () => ({ cards: ["x"], kind: "triplet" as const, kan: false });

  it("top 'Revenge': only with (strictly) the fewest melds; SS this card then draw 2", () => {
    const make = (mine: number, opp: number) => {
      const sess = new GameSession(setup((p) => p("hand", 0, mk("keis", "MJG-C17", { atk: 2, def: 2, value: 2 }))));
      sess.state = M.replace(sess.state, {
        events: [],
        players: sess.state.players.map((p) =>
          p.pid === 0
            ? { ...p, hand: ["keis"], meldZone: Array.from({ length: mine }, meld) }
            : { ...p, meldZone: Array.from({ length: opp }, meld) }),
      });
      return sess;
    };
    const offered = (sess: GameSession) => sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "keis" && a.role === "top");
    expect(offered(make(0, 0))).toBe(false); // tied -> no
    expect(offered(make(1, 1))).toBe(false); // tied -> no
    expect(offered(make(2, 1))).toBe(false); // you have MORE -> no
    const sess = make(0, 2); // strictly fewest
    expect(offered(sess)).toBe(true);
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "keis", role: "top" });
    expect(M.player(sess.state, 0).board).toContain("keis"); // Special Summoned
    expect(M.player(sess.state, 0).hand.length).toBe(2); // drew 2 (keis left the hand)
    expect(sess.state.mainDeck.length).toBe(deck0 - 2);
  });

  // put two known-VALUE cards on top of the deck, set both hands, then activate Treasurer
  const treasurer = (v0: number, v1: number, hands: [string[], string[]]) => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("keis", "MJG-C17", { atk: 2, def: 2, value: 2 }))));
    const insts: Record<string, M.CardInstance> = { t0: mk("t0", "", { value: v0 }), t1: mk("t1", "", { value: v1 }) };
    for (const iid of [...hands[0], ...hands[1]]) insts[iid] = mk(iid);
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, ...insts },
      mainDeck: ["t0", "t1", ...sess.state.mainDeck],
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: hands[0] } : { ...p, hand: hands[1] })),
    });
    sess.command(0, { do: "activate", iid: "keis", role: "bottom" });
    return sess;
  };

  it("bottom 'Treasurer': a VALUE-sum of 6 or 8 adds both revealed cards to your hand", () => {
    const six = treasurer(2, 4, [[], []]); // 2 + 4 = 6
    expect(M.player(six.state, 0).hand).toEqual(expect.arrayContaining(["t0", "t1"]));
    expect(six.state.mainDeck).not.toContain("t0");
    expect(six.state.mainDeck).not.toContain("t1");

    const eight = treasurer(3, 5, [[], []]); // 3 + 5 = 8
    expect(M.player(eight.state, 0).hand).toEqual(expect.arrayContaining(["t0", "t1"]));
  });

  it("bottom: a sum of 7 makes hand>7 players discard half (rounded down); cards shuffle back", () => {
    const myHand = Array.from({ length: 8 }, (_, i) => `h${i}`); // 8 > 7 -> discard floor(8/2) = 4
    const oppHand = Array.from({ length: 6 }, (_, i) => `q${i}`); // 6, not > 7 -> exempt
    const sess = treasurer(3, 4, [myHand, oppHand]); // 3 + 4 = 7
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-C17:bottom");
    for (let i = 0; i < 4; i++) sess.choose(0, { use: true, target: `h${i}` });
    expect(M.player(sess.state, 0).hand.length).toBe(4); // 8 - 4
    expect(M.player(sess.state, 1).hand.length).toBe(6); // untouched (<= 7)
    expect(sess.state.mainDeck).toEqual(expect.arrayContaining(["t0", "t1"])); // shuffled back, not added
  });

  it("bottom: any other sum does nothing but shuffle the revealed cards back", () => {
    const five = treasurer(2, 3, [[], []]); // 2 + 3 = 5
    expect(M.player(five.state, 0).hand.length).toBe(0); // nothing added
    expect(five.state.mainDeck).toEqual(expect.arrayContaining(["t0", "t1"]));
  });
});

describe("MJG-C16 PREZ — The Brick", () => {
  // a hand holding only The Brick
  const brickHand = () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("brick", "MJG-C16", { atk: 9, def: 9, value: 9 }))));
    return M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["brick"] } : p)) });
  };

  it("top 'BRICKED': cannot be normal or special summoned", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("brick", "MJG-C16", { atk: 9, def: 9, value: 9 }));
        p("hand", 0, mk("ok", "", { atk: 1, def: 1 })); // a normal card, for contrast
      }),
    );
    const legal = sess.viewFor(0).legal;
    expect(legal.some((a) => a.kind === "normalSummon" && a.iid === "ok")).toBe(true);
    expect(legal.some((a) => a.kind === "normalSummon" && a.iid === "brick")).toBe(false);
    expect(M.canNormalSummon("MJG-C16")).toBe(false);
    expect(M.canSpecialSummon("MJG-C16")).toBe(false);
  });

  it("a 'Special Summon a random card from hand' effect reveals it instead of summoning", () => {
    const r = applyIntent(brickHand(), { kind: "summonRandomFromHand", player: 0 });
    expect(M.player(r.state, 0).board).not.toContain("brick"); // not summoned
    expect(M.player(r.state, 0).hand).toContain("brick"); // stays in hand
  });

  it("cannot be discarded by the hand-size discard (DiscardDown)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("brick", "MJG-C16", { atk: 9, def: 9, value: 9 }));
        p("hand", 0, mk("a"));
        p("hand", 0, mk("b"));
      }),
    );
    sess.state = M.replace(sess.state, { phase: M.Phase.DISCARD_DOWN });
    const discards = sess.viewFor(0).legal.filter((x) => x.kind === "discard").map((x) => (x as { iid: string }).iid);
    expect(discards).toContain("a");
    expect(discards).toContain("b");
    expect(discards).not.toContain("brick"); // The Brick can't be discarded from the hand
  });

  it("an effect that discards it from the hand reveals it instead", () => {
    const r = applyIntent(brickHand(), { kind: "discard", iid: "brick" });
    expect(M.player(r.state, 0).hand).toContain("brick"); // still in hand
    expect(r.state.discard).not.toContain("brick");
    expect(r.state.log.some((l) => /Brick/.test(l))).toBe(true);
  });

  it("cannot be discarded or banished at random from the hand", () => {
    const d = applyIntent(brickHand(), { kind: "discardRandom", player: 0, count: 1 });
    expect(M.player(d.state, 0).hand).toContain("brick");
    expect(d.state.discard).not.toContain("brick");
    const b = applyIntent(brickHand(), { kind: "banishRandom", player: 0, count: 1 });
    expect(M.player(b.state, 0).hand).toContain("brick");
    expect(b.state.banish).not.toContain("brick");
  });

  it("survives 'discard your entire hand' (Double or Nothing) — only non-Bricks go", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("mida", "MJG-C12", { atk: 5, def: 0, value: 5 }))));
    sess.state = M.replace(sess.state, {
      events: [],
      instances: {
        ...sess.state.instances,
        brick: mk("brick", "MJG-C16", { value: 9 }), m1: mk("m1", "", { value: 1 }),
        theirs: mk("theirs", "", { value: 10 }), // higher than anything seat 0 can reveal -> seat 0 is "lower"
      },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["brick", "m1"] } : { ...p, hand: ["theirs"] })),
    });
    sess.command(0, { do: "activate", iid: "mida", role: "bottom", targets: ["1"] }); // you revealed lower -> discard your whole hand
    drainMass(sess); // order your own discards (the Brick reveals instead of going)
    expect(M.player(sess.state, 0).hand).toEqual(["brick"]); // m1 discarded; The Brick revealed and kept
    expect(sess.state.discard).toContain("m1");
    expect(sess.state.discard).not.toContain("brick");
  });
});

describe("LOB-001 Blue-Eyes — fractional DEF (2.5)", () => {
  it("the card's printed DEF is 2.5 and is not truncated to an int", () => {
    const sess = new GameSession(setup(() => {}));
    // make an instance straight from the registry (like a real summon), not via mk
    sess.state = M.reduce(sess.state, { type: M.ActionType.DEV_SPAWN, player: 0, spawnIid: "lob", spawnCardId: "LOB-001" });
    expect(M.defOf(sess.state, "lob")).toBe(2.5); // base_set.json carries 2.5, statOf keeps it
    expect(M.atkOf(sess.state, "lob")).toBe(3);
    expect(M.valueOf(sess.state, "lob")).toBe(8);
    // fractional arithmetic survives a stat mod: 2.5 * 2 = 5 (an int 2 would give 4)
    const r = applyIntent(sess.state, { kind: "statMod", iid: "lob", stat: "def", op: "mul", amount: 2, duration: "persistent" });
    expect(M.defOf(r.state, "lob")).toBe(5);
  });

  it("the fractional DEF is used in battle (doubled 2.5 = 5 survives ATK 5; an int 2 would not)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 5, def: 5 }));
        p("board", 1, mk("lob", "LOB-001", { atk: 3, def: 2.5, value: 8 }));
      }),
    );
    sess.state = applyIntent(sess.state, { kind: "statMod", iid: "lob", stat: "def", op: "mul", amount: 2, duration: "persistent" }).state;
    expect(M.defOf(sess.state, "lob")).toBe(5); // 2.5 * 2
    sess.command(0, { do: "attack", attacker: "att", target: "lob" }); // 5 ATK is NOT > 5 DEF
    expect(M.player(sess.state, 1).board).toContain("lob"); // survives (had DEF been int 2 -> 4, it would be discarded)
  });
});

describe("MJG-C28 HOSH — Tactical Suppression", () => {
  it("bottom: after Ojisan is attacked, the attacker is stunned until the owner's next turn ends", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 3, def: 3, value: 5 })); // active attacker (survives)
        p("board", 1, mk("oji", "MJG-C28", { atk: 1, def: 4, value: 5 })); // wall: 4 + 1 aura = 5 DEF
      }),
    );
    sess.command(0, { do: "attack", attacker: "att", target: "oji" }); // 3 ATK !> 5 DEF, 1 ATK !> 3 DEF -> both live
    expect(M.player(sess.state, 1).board).toContain("oji");
    expect(M.player(sess.state, 0).board).toContain("att");
    expect(sess.state.instances["att"]?.stunned).toBe(true); // suppressed
    // owner is seat 1; the stun lapses at the end of seat 1's next turn
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" }); // -> seat 1's turn
    expect(sess.state.instances["att"]?.stunned).toBe(true); // still stunned (owner hasn't ended a turn yet)
    sess.command(1, { do: "endTurn" });
    expect(sess.state.instances["att"]?.stunned).toBe(false); // lapses at the end of the owner's turn
  });

  it("bottom: when Ojisan attacks on its owner's turn, the suppression spans the owner's NEXT turn", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("oji", "MJG-C28", { atk: 1, def: 4, value: 5 }));
        p("board", 1, mk("foe", "", { atk: 2, def: 3, value: 5 })); // survives oji's 1 ATK
      }),
    );
    sess.command(0, { do: "attack", attacker: "oji", target: "foe" }); // both live
    expect(sess.state.instances["foe"]?.stunned).toBe(true);
    // owner (seat 0) ending the CURRENT turn does NOT lapse it ("next turn", not this one)
    sess.command(0, { do: "endTurn" });
    expect(sess.state.instances["foe"]?.stunned).toBe(true); // the skip: still stunned through the opponent's turn
    sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" }); // -> seat 1's (foe's) turn — foe is suppressed here
    expect(sess.state.instances["foe"]?.stunned).toBe(true);
    sess.command(1, { do: "endTurn" });
    sess.command(1, { do: "advance" });
    sess.command(0, { do: "draw" }); // -> seat 0's NEXT turn
    expect(sess.state.instances["foe"]?.stunned).toBe(true); // still stunned at the start of the owner's next turn
    sess.command(0, { do: "endTurn" });
    expect(sess.state.instances["foe"]?.stunned).toBe(false); // lapses at the end of the owner's next turn
  });

  it("bottom: if the opponent is discarded by the battle, there is nothing to stun", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("oji", "MJG-C28", { atk: 1, def: 4, value: 5 }));
        p("board", 1, mk("weak", "", { atk: 1, def: 0, value: 5 })); // 1 ATK > 0 DEF -> discarded
      }),
    );
    sess.command(0, { do: "attack", attacker: "oji", target: "weak" });
    expect(M.player(sess.state, 1).board).not.toContain("weak"); // discarded by battle
    expect(M.player(sess.state, 0).board).toContain("oji"); // Ojisan survives; no stun, no error
  });
});

describe("MJG-C31 KOIT — Koito Big Koitus", () => {
  it("top 'Easily Startled': negates an activated reveal-your-hand effect and discards its card", () => {
    // Honester Gamble (MJG-C10) makes the target reveal a hand card; its top is not a
    // SPELL-lock (unlike YUME's Housepet), so Koito — a SPELL — can chain to it.
    const sess = new GameSession(setup((p) => p("board", 0, mk("mary", "MJG-C10", { atk: 2, def: 2, value: 2 }))));
    sess.state = M.replace(sess.state, {
      events: [],
      instances: {
        ...sess.state.instances,
        mine: mk("mine", "", { value: 9 }), theirs: mk("theirs", "", { value: 5 }), koit: mk("koit", "MJG-C31", { value: 1 }),
      },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["mine"] } : { ...p, hand: ["theirs", "koit"] })),
    });
    sess.setToggle(1, "auto");
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "mary", role: "bottom", targets: ["1"] }); // makes seat 1 reveal a hand card
    expect(sess.awaiting).toBe(1); // Koito is offered to the targeted (revealing) player
    sess.respond(1, { activate: { iid: "koit", role: "top" } });
    expect(sess.state.discard).toContain("koit"); // discarded as the cost
    expect(M.player(sess.state, 0).board).not.toContain("mary"); // the source is negated + removed
    expect(sess.state.log.some((l) => l.includes("negated"))).toBe(true);
    // Center Stage K interaction: Koito is now the discard top, so the discarded source is
    // shuffled into the deck instead. The gamble's draw-2 was negated (so deck = deck0 + mary).
    expect(sess.state.mainDeck).toContain("mary");
    expect(sess.state.mainDeck.length).toBe(deck0 + 1);
  });

  it("top: NOT offered against an effect that does not reveal your hand", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("chio", "MJG-003")); // a draw Active — not a hand-reveal
        p("hand", 1, mk("koit", "MJG-C31"));
      }),
    );
    sess.setToggle(1, "auto");
    sess.command(0, { do: "activate", iid: "chio", role: "bottom" });
    expect(sess.awaiting).toBeNull(); // Koito not offered (not a reveal-your-hand effect)
  });

  it("bottom 'Center Stage K': while Koito is the discard top, discards are shuffled into the deck instead", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, koit: mk("koit", "MJG-C31"), vic: mk("vic", "") },
      discard: ["koit"],
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["vic"] } : p)),
    });
    const deck0 = sess.state.mainDeck.length;
    const r = applyIntent(sess.state, { kind: "discard", iid: "vic" });
    expect(r.state.discard).toEqual(["koit"]); // unchanged — vic was NOT discarded
    expect(r.state.mainDeck).toContain("vic"); // shuffled into the deck instead
    expect(r.state.mainDeck.length).toBe(deck0 + 1);
    expect(M.player(r.state, 0).hand).not.toContain("vic"); // left the hand
    expect(r.state.events.some((e) => e.kind === "discarded" && (e as { iid?: string }).iid === "vic")).toBe(false); // not a discard
  });

  it("bottom: when Koito is NOT the discard top, discards happen normally", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, koit: mk("koit", "MJG-C31"), other: mk("other", ""), vic: mk("vic", "") },
      discard: ["other", "koit"], // Koito is buried, not the top
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["vic"] } : p)),
    });
    const r = applyIntent(sess.state, { kind: "discard", iid: "vic" });
    expect(r.state.discard[0]).toBe("vic"); // normal discard to the top
  });
});

describe("MJG-C32 HINA — Hanana", () => {
  it("top 'LTG': the targeted opponent discards a board card of their choice, then you SS this", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("hana", "MJG-C32", { atk: 2, def: 2, value: 2 }));
        p("board", 1, mk("a", "", { atk: 3, def: 3 }));
        p("board", 1, mk("b", "", { atk: 1, def: 1 }));
      }),
    );
    sess.command(0, { do: "activate", iid: "hana", role: "top", targets: ["1"] });
    expect(sess.viewFor(1).choice?.effectId).toBe("MJG-C32:top"); // the OPPONENT chooses
    sess.choose(1, { use: true, target: "a" });
    expect(sess.state.discard).toContain("a"); // their chosen card is discarded
    expect(M.player(sess.state, 1).board).not.toContain("a");
    expect(M.player(sess.state, 1).board).toContain("b"); // they kept the other
    expect(M.player(sess.state, 0).board).toContain("hana"); // and you Special Summon this card
  });

  it("top: NOT activatable when the opponent has no board card to discard", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("hana", "MJG-C32", { atk: 2, def: 2, value: 2 }))));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "hana" && a.role === "top")).toBe(false);
    const r = sess.command(0, { do: "activate", iid: "hana", role: "top", targets: ["1"] });
    expect(r.ok).toBe(false); // rejected outright — no SS off an empty board
    expect(M.player(sess.state, 0).board).not.toContain("hana");
  });

  it("top: an empty-board opponent is not a valid target (only ones with a discardable card)", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("hana", "MJG-C32", { atk: 2, def: 2, value: 2 }));
      p("board", 1, mk("a", "", { atk: 3, def: 3 })); // seat 1 has a board; any other seat doesn't
    }));
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "hana" && a.role === "top");
    expect(act && "targetSeats" in act ? act.targetSeats : undefined).toEqual([1]); // only the boarded opponent
  });

  it("bottom 'Center Stage H': while Hanana is the discard top, draw effects draw exactly 2", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, hana: mk("hana", "MJG-C32") },
      discard: ["hana"],
      players: sess.state.players.map((p) => ({ ...p, hand: [] })),
    });
    const deck0 = sess.state.mainDeck.length;
    const drew1 = applyIntent(sess.state, { kind: "draw", player: 0, count: 1 });
    expect((drew1.result as string[]).length).toBe(2); // a "draw 1" effect draws 2 instead
    expect(drew1.state.mainDeck.length).toBe(deck0 - 2);
    const drew5 = applyIntent(sess.state, { kind: "draw", player: 0, count: 5 });
    expect((drew5.result as string[]).length).toBe(2); // a "draw 5" effect also draws exactly 2
  });

  it("bottom: when Hanana is NOT the discard top, draw effects are unchanged", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, hana: mk("hana", "MJG-C32"), other: mk("other", "") },
      discard: ["other", "hana"], // Hanana buried, not the top
      players: sess.state.players.map((p) => ({ ...p, hand: [] })),
    });
    const r = applyIntent(sess.state, { kind: "draw", player: 0, count: 1 });
    expect((r.result as string[]).length).toBe(1); // normal draw
  });
});

describe("MJG-C33 MADO — Puella Magi Madoka Higuchika", () => {
  it("top 'Cold Attitude': banish a character you control and Special Summon this card", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("mado", "MJG-C33", { atk: 3, def: 3, value: 3 }));
        p("board", 0, mk("mine", "", { atk: 1, def: 1 })); // a character you control
        p("board", 1, mk("foe", "", { atk: 1, def: 1 })); // an opponent's — not a legal target
      }),
    );
    // only your own characters are valid targets
    const legal = sess.viewFor(0).legal.find(
      (a): a is Extract<LA, { kind: "activate" }> => a.kind === "activate" && a.iid === "mado" && a.role === "top",
    );
    expect(legal?.targetIds).toEqual(["mine"]);
    sess.command(0, { do: "activate", iid: "mado", role: "top", targets: ["mine"] });
    expect(sess.state.banish).toContain("mine"); // banished
    expect(M.player(sess.state, 0).board).not.toContain("mine");
    expect(M.player(sess.state, 0).board).toContain("mado"); // Special Summoned
  });

  it("bottom 'Center Stage M': while Madoka is the discard top, discards go to the BOTTOM (still discarded)", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, mado: mk("mado", "MJG-C33"), vic: mk("vic", "") },
      discard: ["mado"],
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["vic"] } : p)),
    });
    const r = applyIntent(sess.state, { kind: "discard", iid: "vic" });
    expect(r.state.discard).toEqual(["mado", "vic"]); // Madoka stays on top; vic goes to the bottom
    expect(M.player(r.state, 0).hand).not.toContain("vic");
    expect(r.state.events.some((e) => e.kind === "discarded" && (e as { iid?: string }).iid === "vic")).toBe(true); // it WAS discarded
  });

  it("bottom: when Madoka is NOT the discard top, discards go to the top as usual", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, mado: mk("mado", "MJG-C33"), other: mk("other", ""), vic: mk("vic", "") },
      discard: ["other", "mado"], // Madoka buried, not the top
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["vic"] } : p)),
    });
    const r = applyIntent(sess.state, { kind: "discard", iid: "vic" });
    expect(r.state.discard[0]).toBe("vic"); // normal discard to the top
  });
});

describe("MJG-C34 TORU — No", () => {
  const meld = (cards: string[]) => ({ cards, kind: "triplet" as const, kan: false });

  it("top 'Solem': discard a meld (cost), then negate + discard an opponent's played card, then discard this", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("chio", "MJG-003")); // an opponent's draw Active (a card to negate)
        p("hand", 1, mk("solem", "MJG-C34", { atk: 4, def: 4, value: 4 }));
      }),
    );
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, mc: mk("mc") },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, meldZone: [meld(["mc"])] } : p)),
    });
    sess.setToggle(1, "auto");
    const hand0 = M.player(sess.state, 0).hand.length;
    sess.command(0, { do: "activate", iid: "chio", role: "bottom" });
    expect(sess.awaiting).toBe(1); // opponent played a card + you have a meld -> Solem offered
    sess.respond(1, { activate: { iid: "solem", role: "top" } });
    expect(sess.viewFor(1).choice?.effectId).toBe("MJG-C34:top"); // choose a meld to discard (cost)
    sess.choose(1, { use: true, target: "0" });
    expect(M.player(sess.state, 1).meldZone.length).toBe(0); // meld discarded (cost paid)
    expect(sess.state.discard).toContain("mc"); // its cards hit the discard
    expect(M.player(sess.state, 0).board).not.toContain("chio"); // negated + discarded
    expect(sess.state.discard).toContain("chio");
    expect(M.player(sess.state, 0).hand.length).toBe(hand0); // the draw never happened
    expect(sess.state.discard).toContain("solem"); // then Solem discards itself
    expect(sess.state.log.some((l) => l.includes("negated"))).toBe(true);
  });

  it("top: NOT offered without a meld to pay the cost", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("chio", "MJG-003"));
        p("hand", 1, mk("solem", "MJG-C34", { atk: 4, def: 4, value: 4 })); // but no meld
      }),
    );
    sess.setToggle(1, "auto");
    sess.command(0, { do: "activate", iid: "chio", role: "bottom" });
    expect(sess.awaiting).toBeNull(); // no meld -> Solem cannot be activated
  });

  it("bottom 'Center Stage T': while No is the discard top, Special Summons are prevented", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("v", "", { atk: 1, def: 1 }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, no: mk("no", "MJG-C34") },
      discard: ["no"],
    });
    const r = applyIntent(sess.state, { kind: "specialSummon", iid: "v", controller: 0 });
    expect(M.player(r.state, 0).board).not.toContain("v"); // SS prevented
    expect(M.player(r.state, 0).hand).toContain("v"); // stays in hand
  });

  it("bottom: when No is NOT the discard top, Special Summon works", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("v", "", { atk: 1, def: 1 }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, no: mk("no", "MJG-C34"), other: mk("other", "") },
      discard: ["other", "no"], // No buried, not the top
    });
    const r = applyIntent(sess.state, { kind: "specialSummon", iid: "v", controller: 0 });
    expect(M.player(r.state, 0).board).toContain("v"); // SS works
  });
});

describe("MJG-M08 SAMU — Friendly Uncle", () => {
  it("top 'Candy': gain control of a [Cunny]/[Shota] and Special Summon this card", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("uncle", "MJG-M08", { atk: 4, def: 2, value: 2 }));
        p("board", 1, mk("foe", "", { atk: 1, def: 1, tribes: ["Cunny"] }));
      }),
    );
    sess.command(0, { do: "activate", iid: "uncle", role: "top", targets: ["foe"] });
    expect(M.player(sess.state, 0).board).toContain("foe"); // gained control
    expect(M.player(sess.state, 1).board).not.toContain("foe");
    expect(M.player(sess.state, 0).board).toContain("uncle"); // Special Summoned
  });

  it("top: only [Cunny]/[Shota] characters are valid targets", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("uncle", "MJG-M08", { atk: 4, def: 2, value: 2 }));
        p("board", 1, mk("plain", "", { atk: 1, def: 1 })); // no qualifying tribe
      }),
    );
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "uncle" && a.role === "top")).toBe(false);
  });

  it("bottom 'PROTECT Newbaggies': opponents cannot attack your other characters, only the Uncle", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("att", "", { atk: 5, def: 5 }));
        p("board", 1, mk("uncle", "MJG-M08", { atk: 4, def: 2, value: 2 }));
        p("board", 1, mk("other", "", { atk: 1, def: 1 }));
      }),
    );
    expect(M.cannotBeAttacked(sess.state, "other")).toBe(true); // protected
    expect(M.cannotBeAttacked(sess.state, "uncle")).toBe(false); // the Uncle itself is attackable
    expect(sess.command(0, { do: "attack", attacker: "att", target: "other" }).ok).toBe(false); // blocked
    const r = sess.command(0, { do: "attack", attacker: "att", target: "uncle" });
    expect(r.ok).toBe(true);
    expect(M.player(sess.state, 1).board).not.toContain("uncle"); // 5 ATK > 2 DEF -> discarded
  });
});

describe("MJG-014 HNTA — Anon's Mom (Faith)", () => {
  it("top 'Art': Special Summon from hand by discarding cards whose DEF totals exactly 7", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, mom: mk("mom", "MJG-014", { atk: 0, def: 7, value: 7 }), a: mk("a", "", { def: 4 }), b: mk("b", "", { def: 3 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["mom", "a", "b"] } : p)),
    });
    sess.command(0, { do: "activate", iid: "mom", role: "top" });
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-014:top"); // pick cost cards (DEF total 7)
    sess.choose(0, { use: true, target: "a" }); // DEF 4
    sess.choose(0, { use: true, target: "b" }); // DEF 3 -> total 7
    expect(M.player(sess.state, 0).board).toContain("mom"); // Special Summoned
    expect(M.player(sess.state, 0).hand).not.toContain("mom");
    expect(sess.state.discard).toEqual(expect.arrayContaining(["a", "b"])); // the cost
  });

  it("top: a board card's current DEF can pay the cost", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, mom: mk("mom", "MJG-014", { atk: 0, def: 7, value: 7 }), bd: mk("bd", "", { def: 7 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["mom"], board: ["bd"] } : p)),
    });
    sess.command(0, { do: "activate", iid: "mom", role: "top" });
    sess.choose(0, { use: true, target: "bd" }); // a 7-DEF board card
    expect(M.player(sess.state, 0).board).toContain("mom"); // Special Summoned
    expect(M.player(sess.state, 0).board).not.toContain("bd"); // discarded from the board
    expect(sess.state.discard).toContain("bd");
  });

  it("top: not offered when no subset of your cards' DEF totals exactly 7", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, mom: mk("mom", "MJG-014", { atk: 0, def: 7, value: 7 }), x: mk("x", "", { def: 2 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["mom", "x"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "mom" && a.role === "top")).toBe(false);
  });
});

describe("MJG-016 CHU2 — ما شاء الله (Faith)", () => {
  it("top: SS by discarding a card with 8 DEF; the summon trigger banishes all other face-up cards", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances,
        mw: mk("mw", "MJG-016", { atk: 7, def: 8, value: 6 }),
        cost: mk("cost", "", { def: 8 }), mine: mk("mine", "", { atk: 1, def: 1 }), foe: mk("foe", "", { atk: 1, def: 1 }),
      },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["mw", "cost"], board: ["mine"] } : { ...p, board: ["foe"] })),
    });
    sess.command(0, { do: "activate", iid: "mw", role: "top" });
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-016:top"); // pick the matching cost
    sess.choose(0, { use: true, target: "cost" });
    expect(M.player(sess.state, 0).board).toContain("mw"); // Special Summoned
    expect(sess.state.discard).toContain("cost"); // the cost (discarded, not banished)
    expect(sess.state.banish).toEqual(expect.arrayContaining(["mine", "foe"])); // all other face-up cards banished
    expect(M.player(sess.state, 0).board).not.toContain("mine");
    expect(M.player(sess.state, 1).board).not.toContain("foe");
    expect(sess.state.banish).not.toContain("mw"); // the summoned card survives
  });

  it("top: a matching ATK (7) or VALUE (6) also pays the cost", () => {
    const make = (over: Partial<M.CardInstance>) => {
      const sess = new GameSession(setup(() => {}));
      sess.state = M.replace(sess.state, {
        instances: { ...sess.state.instances, mw: mk("mw", "MJG-016", { atk: 7, def: 8, value: 6 }), c: mk("c", "", over) },
        players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["mw", "c"] } : p)),
      });
      sess.command(0, { do: "activate", iid: "mw", role: "top" });
      sess.choose(0, { use: true, target: "c" });
      return sess;
    };
    expect(M.player(make({ atk: 7, def: 1, value: 1 }).state, 0).board).toContain("mw"); // ATK 7
    expect(M.player(make({ atk: 1, def: 1, value: 6 }).state, 0).board).toContain("mw"); // VALUE 6
  });

  it("top: not offered without a card matching 7 ATK / 8 DEF / 6 VALUE", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, mw: mk("mw", "MJG-016", { atk: 7, def: 8, value: 6 }), x: mk("x", "", { atk: 1, def: 1, value: 1 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["mw", "x"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "mw" && a.role === "top")).toBe(false);
  });
});

describe("MJG-025 LILY — HOLY MAHJONG (Faith)", () => {
  it("top 'Resurrection': the current player discards 3 hand cards to SS it from the discard pile", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, holy: mk("holy", "MJG-025", { atk: 0, def: 0, value: 7 }), h1: mk("h1"), h2: mk("h2"), h3: mk("h3"), h4: mk("h4") },
      discard: ["holy"],
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["h1", "h2", "h3", "h4"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "holy" && a.role === "top")).toBe(true);
    sess.command(0, { do: "activate", iid: "holy", role: "top" });
    sess.choose(0, { use: true, target: "h1" });
    sess.choose(0, { use: true, target: "h2" });
    // mid-cost: the already-picked cards are exposed so the client can outline them
    expect(sess.viewFor(0).choice?.picked).toEqual(["h1", "h2"]);
    sess.choose(0, { use: true, target: "h3" });
    expect(M.player(sess.state, 0).board).toContain("holy"); // resurrected from the discard
    expect(sess.state.discard).not.toContain("holy");
    expect(sess.state.discard).toEqual(expect.arrayContaining(["h1", "h2", "h3"])); // the cost
    expect(M.player(sess.state, 0).hand).toEqual(["h4"]); // only 3 discarded
  });

  it("top: not offered with fewer than 3 cards in hand", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, holy: mk("holy", "MJG-025"), h1: mk("h1"), h2: mk("h2") },
      discard: ["holy"],
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["h1", "h2"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "holy" && a.role === "top")).toBe(false);
  });

  it("bottom 'New Covenant': banish this, all players shuffle hand+board into the deck and draw 5", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      events: [],
      instances: { ...sess.state.instances, holy: mk("holy", "MJG-025"), a: mk("a"), b: mk("b"), c: mk("c"), d: mk("d") },
      players: sess.state.players.map((p) =>
        p.pid === 0 ? { ...p, hand: ["a", "b"], board: ["holy", "c"] } : { ...p, hand: ["d"], board: [] }),
    });
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "holy", role: "bottom" });
    expect(sess.state.banish).toContain("holy"); // banished as the cost
    expect(M.player(sess.state, 0).hand.length).toBe(5); // shuffled in, then drew 5
    expect(M.player(sess.state, 1).hand.length).toBe(5);
    expect(M.player(sess.state, 0).board).toEqual([]); // board shuffled into the deck
    expect(M.player(sess.state, 1).board).toEqual([]);
    expect(sess.state.mainDeck.length).toBe(deck0 + 4 - 10); // +a,b,c,d shuffled in, -10 drawn
  });
});

describe("MJG-027 SWRD — Swordslut (Faith)", () => {
  const summon = () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances,
        sw: mk("sw", "MJG-027", { atk: 3, def: 7, value: 5 }),
        foe1: mk("foe1", "", { atk: 5, def: 5 }), foe2: mk("foe2", "", { atk: 9, def: 1 }), mine: mk("mine", "", { atk: 4, def: 4 }),
      },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["sw"], board: ["mine"] } : { ...p, board: ["foe1", "foe2"] })),
    });
    sess.command(0, { do: "activate", iid: "sw", role: "top" });
    return sess;
  };

  it("top 'Glorious Nippon Steel': SS this card and set all opponent ATK to 0 (own unaffected)", () => {
    const sess = summon();
    expect(M.player(sess.state, 0).board).toContain("sw"); // Special Summoned (no cost)
    expect(M.atkOf(sess.state, "foe1")).toBe(0); // opponent ATK reduced
    expect(M.atkOf(sess.state, "foe2")).toBe(0);
    expect(M.atkOf(sess.state, "mine")).toBe(4); // your own character unaffected
    expect(M.atkOf(sess.state, "sw")).toBe(3); // the summoned card unaffected
  });

  it("top: the ATK reduction lasts only until the end of this turn", () => {
    const sess = summon();
    expect(M.atkOf(sess.state, "foe1")).toBe(0);
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    expect(M.atkOf(sess.state, "foe1")).toBe(5); // restored at the turn change
  });
});

describe("MJG-036 FOXX — Touch Fluffy Tail (Faith)", () => {
  it("top '9 Tailed Fox': shuffle the top 9 of the discard into the deck, SS, gain all [Furry]", () => {
    const sess = new GameSession(setup(() => {}));
    const dcards = Array.from({ length: 9 }, (_, i) => `d${i}`);
    const insts: Record<string, M.CardInstance> = {};
    for (const iid of dcards) insts[iid] = mk(iid);
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances, ...insts,
        fox: mk("fox", "MJG-036", { atk: 3, def: 3, value: 1, tribes: ["Furry", "Hag"] }),
        furA: mk("furA", "", { tribes: ["Furry"] }), plain: mk("plain", "", {}), furB: mk("furB", "", { tribes: ["Furry"] }),
      },
      discard: dcards,
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["fox"], board: ["furB"] } : { ...p, board: ["furA", "plain"] })),
    });
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "fox", role: "top" });
    expect(M.player(sess.state, 0).board).toContain("fox"); // Special Summoned
    expect(sess.state.discard.length).toBe(0); // top 9 shuffled away
    expect(sess.state.mainDeck.length).toBe(deck0 + 9);
    expect(M.player(sess.state, 0).board).toContain("furA"); // gained control of the opponent's [Furry]
    expect(M.player(sess.state, 1).board).not.toContain("furA");
    expect(M.player(sess.state, 1).board).toContain("plain"); // non-[Furry] not taken
  });

  it("top: not offered with fewer than 9 cards in the discard pile", () => {
    const sess = new GameSession(setup(() => {}));
    const dcards = Array.from({ length: 8 }, (_, i) => `d${i}`);
    const insts: Record<string, M.CardInstance> = {};
    for (const iid of dcards) insts[iid] = mk(iid);
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, ...insts, fox: mk("fox", "MJG-036", { atk: 3, def: 3, value: 1, tribes: ["Furry"] }) },
      discard: dcards,
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["fox"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "fox" && a.role === "top")).toBe(false);
  });

  it("bottom 'Sacred Enjou': gain control of another character, then discard it at end of turn", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("fox", "MJG-036", { atk: 3, def: 3, value: 1, tribes: ["Furry"] }));
        p("board", 1, mk("foe", "", { atk: 2, def: 2 }));
      }),
    );
    sess.command(0, { do: "activate", iid: "fox", role: "bottom", targets: ["foe"] });
    expect(M.player(sess.state, 0).board).toContain("foe"); // gained control this turn
    expect(M.player(sess.state, 1).board).not.toContain("foe");
    sess.command(0, { do: "endTurn" });
    expect(M.player(sess.state, 0).board).not.toContain("foe"); // discarded at the end of the turn
    expect(sess.state.discard).toContain("foe");
  });
});

describe("MJG-040 CHEM — Crimson Chemist (Faith)", () => {
  it("top 'A Worthy Disciple': choose up to 3 effects (draw, set VALUE, discard by DEF)", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances, chem: mk("chem", "MJG-040", { atk: 3, def: 3, value: 4 }),
        d2a: mk("d2a", "", { def: 2 }), d2b: mk("d2b", "", { def: 2 }), d5: mk("d5", "", { def: 5 }),
      },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: [], board: ["chem"] } : { ...p, board: ["d2a", "d2b", "d5"] })),
    });
    sess.command(0, { do: "activate", iid: "chem", role: "top" });
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-040:top");
    sess.choose(0, { use: true, target: "dr" }); // draw 1
    sess.choose(0, { use: true, target: "v" }); // change VALUE...
    sess.choose(0, { use: true, target: "5" }); // ...to 5
    sess.choose(0, { use: true, target: "dd" }); // discard opponents with DEF...
    sess.choose(0, { use: true, target: "2" }); // ...2  (3rd effect -> auto-resolves)
    drainMass(sess); // seat 1 orders their own DEF-2 discards
    expect(M.player(sess.state, 0).hand.length).toBe(1); // drew 1
    expect(M.valueOf(sess.state, "chem")).toBe(5); // VALUE set to 5
    expect(M.player(sess.state, 1).board).not.toContain("d2a"); // DEF-2 opponents discarded
    expect(M.player(sess.state, 1).board).not.toContain("d2b");
    expect(M.player(sess.state, 1).board).toContain("d5"); // DEF-5 untouched
  });

  it("top: SS a VALUE-2/5/8 hand card and flip an opponent face-down (until end of their next turn), then Done", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, chem: mk("chem", "MJG-040", { atk: 3, def: 3, value: 4 }), v5: mk("v5", "", { atk: 1, def: 1, value: 5 }), foe: mk("foe", "", { atk: 2, def: 2 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["v5"], board: ["chem"] } : { ...p, board: ["foe"] })),
    });
    sess.command(0, { do: "activate", iid: "chem", role: "top" });
    sess.choose(0, { use: true, target: "ss" }); // Special Summon from hand...
    sess.choose(0, { use: true, target: "v5" }); // ...the VALUE-5 card
    sess.choose(0, { use: true, target: "fl" }); // flip an opponent character...
    sess.choose(0, { use: true, target: "foe" }); // ...foe
    sess.choose(0, { use: true, target: "done" });
    expect(M.player(sess.state, 0).board).toContain("v5"); // Special Summoned
    expect(sess.state.instances["foe"]?.faceDown).toBe(true); // flipped face-down
    // it stays down through the opponent's next turn, flipping up at the end of it
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" });
    expect(sess.state.instances["foe"]?.faceDown).toBe(true); // still down during their turn
    sess.command(1, { do: "endTurn" });
    expect(sess.state.instances["foe"]?.faceDown).toBe(false); // up at the end of their turn
  });

  it("top: 'once per player' — a player cannot use it twice", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, chem: mk("chem", "MJG-040", { atk: 3, def: 3, value: 4 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, board: ["chem"] } : p)),
    });
    sess.command(0, { do: "activate", iid: "chem", role: "top" });
    sess.choose(0, { use: true, target: "dr" });
    sess.choose(0, { use: true, target: "done" });
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, chem: { ...sess.state.instances["chem"]!, tapped: false } } });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "chem" && a.role === "top")).toBe(false);
  });
});

describe("MJG-042 PHNX — Resplendent Phoenix (Faith)", () => {
  const ashes = (extra: (state: M.GameState) => M.GameState = (s) => s) => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(extra(M.replace(sess.state, {
      instances: { ...sess.state.instances, phx: mk("phx", "MJG-042", { atk: 8, def: 8 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["phx"] } : p)),
    })), {});
    sess.command(0, { do: "activate", iid: "phx", role: "top" });
    return sess;
  };

  it("top 'Ashes': discard your whole hand + face-up board (face-down stay), this card included", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, phx: mk("phx", "MJG-042", { atk: 8, def: 8 }), h1: mk("h1"), bd: mk("bd"), fd: mk("fd", "", { faceDown: true }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["phx", "h1"], board: ["bd", "fd"] } : p)),
    });
    sess.command(0, { do: "activate", iid: "phx", role: "top" });
    // the controller picks the hand's discard order (reorder prompt)
    expect(sess.viewFor(0).choice?.reorder).toBe(true);
    sess.choose(0, { use: true, order: ["h1", "phx"] });
    expect(M.player(sess.state, 0).hand).toEqual([]); // entire hand discarded
    expect(M.player(sess.state, 0).board).toEqual(["fd"]); // face-up discarded; face-down stays
    // chosen order honored: h1 first, phx second, then the board card — last lands on top
    expect(sess.state.discard.slice(0, 3)).toEqual(["bd", "phx", "h1"]);
    expect(sess.state.unlimitedSummon).not.toBeNull(); // unlimited-summon window opened
  });

  it("top: all players may Normal Summon any number of times after Ashes", () => {
    const sess = ashes((s) => M.replace(s, {
      instances: { ...s.instances, s1: mk("s1", "", { atk: 1, def: 1 }), s2: mk("s2", "", { atk: 1, def: 1 }) },
    }));
    // Ashes emptied the hand; hand back two summonable cards
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["s1", "s2"] } : p)) });
    sess.command(0, { do: "summon", iid: "s1" });
    expect(M.player(sess.state, 0).board).toContain("s1");
    expect(sess.viewFor(0).legal.some((a) => a.kind === "normalSummon" && a.iid === "s2")).toBe(true); // normally blocked
    sess.command(0, { do: "summon", iid: "s2" });
    expect(M.player(sess.state, 0).board).toContain("s2");
  });

  it("top + bottom 'Rebirth': returns from the discard at the start of your next turn and draws 5", () => {
    const sess = ashes();
    expect(sess.state.discard).toContain("phx");
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" }); // seat 1's turn
    sess.command(1, { do: "draw" });
    sess.command(1, { do: "endTurn" });
    sess.command(1, { do: "advance" }); // -> start of seat 0's next turn: Phoenix returns
    expect(M.player(sess.state, 0).board).toContain("phx"); // Special Summoned from the discard
    expect(sess.state.discard).not.toContain("phx");
    expect(M.player(sess.state, 0).hand.length).toBe(5); // Rebirth: draw 5 (before the turn draw)
    // the Rebirth chain must NOT swallow the turn draw: we're back in the pre-draw
    // phase and drawing for turn still works
    expect(sess.state.phase).toBe(M.Phase.TURN_START_DRAW);
    const r = sess.command(0, { do: "draw" });
    expect(r.ok).toBe(true);
    expect(M.player(sess.state, 0).hand.length).toBe(6); // 5 (Rebirth) + the turn draw
  });

  it("top: will not return if it has left the discard pile", () => {
    const sess = ashes();
    sess.state = M.replace(sess.state, { discard: sess.state.discard.filter((x) => x !== "phx"), banish: ["phx"] });
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" });
    sess.command(1, { do: "endTurn" });
    sess.command(1, { do: "advance" }); // start of seat 0's next turn
    expect(M.player(sess.state, 0).board).not.toContain("phx"); // not summoned (removed from the discard)
  });
});

describe("MJG-048 LIYA — snek feet (Faith)", () => {
  it("top 'Puberty': Special Summon by overlaying it on a [Cunny]", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, liya: mk("liya", "MJG-048", { atk: 2, def: 2, value: 8 }), cun: mk("cun", "", { tribes: ["Cunny"] }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["liya"], board: ["cun"] } : p)),
    });
    sess.command(0, { do: "activate", iid: "liya", role: "top", targets: ["cun"] });
    expect(M.player(sess.state, 0).board).toContain("liya"); // Special Summoned
    expect(M.player(sess.state, 0).board).not.toContain("cun"); // the [Cunny] is tucked beneath
    expect(sess.state.instances["liya"]?.overlays).toContain("cun");
  });

  it("top: not offered without a [Cunny] to overlay onto", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, liya: mk("liya", "MJG-048", { atk: 2, def: 2, value: 8 }), plain: mk("plain", "", {}) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["liya"], board: ["plain"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "liya" && a.role === "top")).toBe(false);
  });

  it("bottom 'Snake Bite': a poisoned opponent discards 1 per Poison counter when they play a card next turn", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, liya: mk("liya", "MJG-048", { atk: 2, def: 2, value: 8 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, board: ["liya"] } : p)),
    });
    sess.command(0, { do: "activate", iid: "liya", role: "bottom", targets: ["1"] });
    expect(M.player(sess.state, 1).counters["poison"]).toBe(1); // poisoned
    expect(sess.state.pendingPoison).toContain(1); // armed for their next turn
    // the poison is public info on every seat's view: counter count + armed status
    expect(sess.viewFor(0).players.find((p) => p.pid === 1)?.counters?.["poison"]).toBe(1);
    expect(sess.viewFor(0).players.find((p) => p.pid === 1)?.poison).toBe("armed");
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" }); // -> seat 1's (poisoned) turn
    expect(sess.state.poisonActive).toContain(1);
    expect(sess.viewFor(1).players.find((p) => p.pid === 1)?.poison).toBe("active");
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, s1: mk("s1", "", { atk: 1, def: 1 }), extra: mk("extra") },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, hand: ["s1", "extra"] } : p)),
    });
    sess.command(1, { do: "summon", iid: "s1" }); // playing a card -> discard 1 (not the summoned card)
    expect(M.player(sess.state, 1).board).toContain("s1");
    expect(sess.state.discard).toContain("extra");
    expect(M.player(sess.state, 1).hand).not.toContain("extra");
    // the poison is consumed at the end of that turn
    sess.command(1, { do: "endTurn" });
    expect(M.player(sess.state, 1).counters["poison"]).toBe(0);
    expect(sess.state.poisonActive).not.toContain(1);
  });

  /** Poison seat 1 and advance to their (poisoned) turn. */
  const poisoned = () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, liya: mk("liya", "MJG-048", { atk: 2, def: 2, value: 8 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, board: ["liya"] } : p)),
    });
    sess.command(0, { do: "activate", iid: "liya", role: "bottom", targets: ["1"] });
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" });
    expect(sess.state.poisonActive).toContain(1);
    return sess;
  };

  it("poison: a SPELL that Special Summons itself charges exactly once", () => {
    const sess = poisoned();
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, ny: mk("ny", "MJG-001", { atk: 1, def: 1, value: 1 }), f1: mk("f1"), f2: mk("f2") },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, hand: ["ny", "f1", "f2"], actedThisTurn: false } : p)),
    });
    sess.command(1, { do: "activate", iid: "ny", role: "top" }); // Chi on First Turn: SS self + draw 1
    expect(M.player(sess.state, 1).board).toContain("ny");
    // exactly ONE filler discarded (the spell announce) — the self-SS didn't double-charge
    const burned = ["f1", "f2"].filter((x) => sess.state.discard.includes(x));
    expect(burned.length).toBe(1);
  });

  it("poison: an effect Special Summoning ANOTHER card charges; melds do not charge", () => {
    const sess = poisoned();
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances,
        moj: mk("moj", "MJG-043", { atk: 2, def: 2, value: 2 }),
        t3: mk("t3", "", { atk: 3, def: 1, value: 2 }), f1: mk("f1"),
        v1: mk("v1", "", { value: 2 }), v2: mk("v2", "", { value: 2 }), v3: mk("v3", "", { value: 2 }),
      },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, hand: ["t3", "f1"], board: ["moj", "v1", "v2", "v3"], actedThisTurn: false } : p)),
    });
    sess.command(1, { do: "activate", iid: "moj", role: "bottom" }); // Mojito: SS a 3-ATK hand card (an ACTIVE — no spell charge)
    sess.choose(1, { use: true, target: "t3" });
    expect(M.player(sess.state, 1).board).toContain("t3");
    expect(sess.state.discard).toContain("f1"); // the SS of another card charged 1
    // a meld is NOT "playing a card": no further discard
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, f2: mk("f2") },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, hand: ["f2"] } : p)),
    });
    sess.command(1, { do: "meld", materials: ["v1", "v2", "v3"] });
    expect(M.player(sess.state, 1).hand).toContain("f2"); // untouched by the meld
  });
});

describe("MJG-C13 AKAG — Magical Sands (Faith)", () => {
  it("top 'Depths of Hell': Special Summon from hand by banishing 6 other hand cards", () => {
    const sess = new GameSession(setup(() => {}));
    const h6 = Array.from({ length: 6 }, (_, i) => `h${i}`);
    const insts: Record<string, M.CardInstance> = {};
    for (const iid of h6) insts[iid] = mk(iid);
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, ...insts, ms: mk("ms", "MJG-C13", { atk: 6, def: 6, value: 6 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["ms", ...h6] } : p)),
    });
    sess.command(0, { do: "activate", iid: "ms", role: "top" });
    for (const iid of h6) sess.choose(0, { use: true, target: iid });
    expect(M.player(sess.state, 0).board).toContain("ms"); // Special Summoned
    expect(M.player(sess.state, 0).hand).not.toContain("ms");
    h6.forEach((iid) => expect(sess.state.banish).toContain(iid)); // the cost — banished
  });

  it("top: not offered with fewer than 6 other cards in hand", () => {
    const sess = new GameSession(setup(() => {}));
    const h5 = Array.from({ length: 5 }, (_, i) => `h${i}`);
    const insts: Record<string, M.CardInstance> = {};
    for (const iid of h5) insts[iid] = mk(iid);
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, ...insts, ms: mk("ms", "MJG-C13", { atk: 6, def: 6, value: 6 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["ms", ...h5] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "ms" && a.role === "top")).toBe(false);
  });

  it("bottom 'The Second Hand': make a Special Meld from 3 discard cards that form a meld", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, ms: mk("ms", "MJG-C13", { atk: 6, def: 6, value: 6 }), d1: mk("d1", "", { value: 1 }), d2: mk("d2", "", { value: 2 }), d3: mk("d3", "", { value: 3 }) },
      discard: ["d1", "d2", "d3"],
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, board: ["ms"] } : p)),
    });
    const meld0 = M.player(sess.state, 0).meldZone.length;
    sess.command(0, { do: "activate", iid: "ms", role: "bottom", targets: ["d1", "d2", "d3"] });
    expect(M.player(sess.state, 0).meldZone.length).toBe(meld0 + 1); // a Special Meld formed
    ["d1", "d2", "d3"].forEach((iid) => expect(sess.state.discard).not.toContain(iid)); // materials left the discard
    // once per turn: not offered again after use (even with another valid triple available)
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, ms: { ...sess.state.instances["ms"]!, tapped: false }, e1: mk("e1", "", { value: 4 }), e2: mk("e2", "", { value: 4 }), e3: mk("e3", "", { value: 4 }) },
      discard: ["e1", "e2", "e3"],
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "ms" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-C14 WSHZ — Waschizo (Faith)", () => {
  it("top 'Post-War Showa Era': Special Summon by overlaying it on a character that has battled 6 times", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, wz: mk("wz", "MJG-C14", { atk: 7, def: 5, value: 6 }), vet: mk("vet", "", { battles: 6 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["wz"], board: ["vet"] } : p)),
    });
    sess.command(0, { do: "activate", iid: "wz", role: "top", targets: ["vet"] });
    expect(M.player(sess.state, 0).board).toContain("wz"); // Special Summoned
    expect(M.player(sess.state, 0).board).not.toContain("vet"); // the veteran is tucked beneath
    expect(sess.state.instances["wz"]?.overlays).toContain("vet");
  });

  it("top: not offered when no character has battled 6 times", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, wz: mk("wz", "MJG-C14", { atk: 7, def: 5, value: 6 }), green: mk("green", "", { battles: 5 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["wz"], board: ["green"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "wz" && a.role === "top")).toBe(false);
  });

  it("bottom 'WASHI NO IIPIN': draw 12 cards, once per turn", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("wz", "MJG-C14", { atk: 7, def: 5, value: 6 }))));
    const hand0 = M.player(sess.state, 0).hand.length;
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "wz", role: "bottom" });
    const drawn = Math.min(12, deck0);
    expect(M.player(sess.state, 0).hand.length).toBe(hand0 + drawn); // drew 12 (or the rest of the deck)
    expect(sess.state.mainDeck.length).toBe(deck0 - drawn);
    // once per turn: not offered again after use
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "wz" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-CC C2C2 — Pizza Hut (Faith)", () => {
  it("top 'C.C.': Special Summon from hand and place a Code counter on it", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("ph", "MJG-CC", { atk: 2, def: 2, value: 2 }))));
    sess.command(0, { do: "activate", iid: "ph", role: "top" });
    expect(M.player(sess.state, 0).board).toContain("ph"); // Special Summoned
    expect(M.player(sess.state, 0).hand).not.toContain("ph");
    expect(sess.state.instances["ph"]?.counters["code"]).toBe(1); // gained a Code counter
  });

  it("C.C. replacement: a Pizza Hut that would be discarded by battle gains a Code counter instead", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("ph", "MJG-CC", { atk: 2, def: 2, value: 2, counters: { code: 1 } })); // your losing attacker
      p("board", 1, mk("def", "", { atk: 5, def: 5 })); // opponent's strong defender
    }));
    sess.command(0, { do: "attack", attacker: "ph", target: "def" });
    expect(M.player(sess.state, 0).board).toContain("ph"); // not discarded — C.C. replacement
    expect(sess.state.discard).not.toContain("ph");
    expect(sess.state.instances["ph"]?.counters["code"]).toBe(2); // 1 -> 2
  });

  it("bottom 'Code' (Passive): at the start of your turn remove a Code counter; when none remain, search the Faith Deck for The Cart Driver", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("ph", "MJG-CC", { atk: 2, def: 2, value: 2, counters: { code: 1 } }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, lulu: mk("lulu", "MJG-ZERO", { atk: 0, def: 0, value: 0 }) },
      faithDeck: ["lulu"],
    });
    const round = () => { // play seat 0's turn then seat 1's, returning at the start of seat 0's next
      sess.command(0, { do: "endTurn" }); sess.command(0, { do: "advance" });
      sess.command(1, { do: "draw" }); sess.command(1, { do: "endTurn" }); sess.command(1, { do: "advance" });
    };
    round(); // start of seat 0's 2nd turn: 1 counter -> remove 1 (still has had counters, no search)
    expect(sess.state.instances["ph"]?.counters["code"]).toBe(0);
    expect(M.player(sess.state, 0).hand).not.toContain("lulu");
    sess.command(0, { do: "draw" }); round(); // start of seat 0's 3rd turn: 0 counters -> search
    expect(M.player(sess.state, 0).hand).toContain("lulu");
    expect(sess.state.faithDeck).not.toContain("lulu");
  });
});

describe("MJG-ZERO LULU — The Cart Driver (Faith)", () => {
  it("top 'L.L.': Special Summon by overlaying it on \"Pizza Hut\"", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("zero", "MJG-ZERO", { atk: 0, def: 0, value: 0 }));
      p("board", 0, mk("ph", "MJG-CC", { atk: 2, def: 2, value: 2 }));
    }));
    sess.command(0, { do: "activate", iid: "zero", role: "top", targets: ["ph"] });
    expect(M.player(sess.state, 0).board).toContain("zero"); // Special Summoned
    expect(M.player(sess.state, 0).board).not.toContain("ph"); // Pizza Hut tucked beneath
    expect(sess.state.instances["zero"]?.overlays).toContain("ph");
  });

  it("top: not offered without a \"Pizza Hut\" to overlay onto", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("zero", "MJG-ZERO", { atk: 0, def: 0, value: 0 }));
      p("board", 0, mk("plain", "", {}));
    }));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "zero" && a.role === "top")).toBe(false);
  });

  it("bottom 'Geass': control the targeted opponent's next turn; only once per game on the same player", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("zero", "MJG-ZERO", { atk: 0, def: 0, value: 0 }))));
    sess.command(0, { do: "activate", iid: "zero", role: "bottom", targets: ["1"] });
    expect(sess.state.geassTargets).toContain(1);
    expect(sess.state.pendingTurnControl).toEqual([{ player: 1, by: 0 }]);
    // advance into seat 1's (controlled) turn
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    expect(sess.state.activePlayer).toBe(1);
    expect(sess.state.turnControlledBy).toBe(0);
    // the CONTROLLER's perspective fully becomes seat 1's: viewer, hand, legal actions
    const v0 = sess.viewFor(0);
    expect(v0.viewer).toBe(1); // sees the game AS seat 1
    expect(v0.players.find((p) => p.pid === 1)?.hand).toBeTruthy(); // the target's hand is open
    expect(v0.players.find((p) => p.pid === 0)?.hand).toBeFalsy(); // their own hand is now "an opponent's"
    expect(v0.legal.some((a) => a.kind === "draw")).toBe(true); // the draw-for-turn button
    // the TARGET just watches: no actions, no prompts
    const v1 = sess.viewFor(1);
    expect(v1.legal).toEqual([]);
    expect(v1.awaiting).toBe(false);
    expect(sess.respond(1, { pass: true }).ok).toBe(false); // inputs blocked outright
    // the controlled player is locked out; the controller drives the turn as seat 1
    expect(sess.command(1, { do: "draw" }).ok).toBe(false);
    expect(sess.command(0, { do: "draw" }).ok).toBe(true); // controller draws using seat 1's deck
    // controller can summon using seat 1's hand and board
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, s1: mk("s1", "", { atk: 1, def: 1 }) },
      players: sess.state.players.map((pl) => (pl.pid === 1 ? { ...pl, hand: [...pl.hand, "s1"] } : pl)),
    });
    expect(sess.command(0, { do: "summon", iid: "s1" }).ok).toBe(true);
    expect(M.player(sess.state, 1).board).toContain("s1"); // summoned to the controlled player's board
    // control lasts exactly one turn
    sess.command(0, { do: "endTurn" });
    sess.command(0, { do: "advance" });
    expect(sess.state.turnControlledBy).toBeNull();
    expect(sess.state.activePlayer).toBe(0);
    // once per game on the same player: Geass not offered against seat 1 again
    sess.command(0, { do: "draw" });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "zero" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-C21 SUZA — Spinzaku (Faith)", () => {
  it("top 'Lancelot': Special Summon by overlaying it on any character", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("spin", "MJG-C21", { atk: 9, def: 7, value: 5 }));
      p("board", 0, mk("fodder", "", { atk: 1, def: 1 })); // any character
    }));
    sess.command(0, { do: "activate", iid: "spin", role: "top", targets: ["fodder"] });
    expect(M.player(sess.state, 0).board).toContain("spin"); // Special Summoned
    expect(M.player(sess.state, 0).board).not.toContain("fodder"); // tucked beneath
    expect(sess.state.instances["spin"]?.overlays).toContain("fodder");
  });

  it("LIVE!: a Spinzaku that would be discarded by battle is overlaid beneath another of your characters", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("spin", "MJG-C21", { atk: 2, def: 2, value: 5 })); // a weakened Spinzaku that loses
      p("board", 0, mk("ally", "", { atk: 3, def: 3 })); // your other character (the host)
      p("board", 1, mk("def", "", { atk: 9, def: 9 }));
    }));
    sess.state = M.replace(sess.state, { // pin the host's table spot to assert inheritance
      instances: { ...sess.state.instances, ally: { ...sess.state.instances["ally"]!, pos: { x: 300, y: 35, page: 0 } } },
    });
    sess.command(0, { do: "attack", attacker: "spin", target: "def" });
    expect(sess.state.discard).not.toContain("spin"); // not discarded — LIVE!
    // several candidate hosts (ally + the opponent's def): the OWNER picks
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-C21:bottom");
    expect((sess.viewFor(0).choice?.options ?? []).map((o) => o.iid).sort()).toEqual(["ally", "def"]);
    sess.choose(0, { use: true, target: "ally" });
    expect(sess.state.instances["spin"]?.pos).toEqual({ x: 300, y: 35, page: 0 }); // takes the host's table spot
    expect(M.player(sess.state, 0).board).toContain("spin"); // covers the ally (stack top)
    expect(M.player(sess.state, 0).board).not.toContain("ally");
    expect(sess.state.instances["spin"]?.overlays).toContain("ally");
  });

  it("LIVE!: with no character of your own, Spinzaku is overlaid beneath an opponent's character", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("spin", "MJG-C21", { atk: 2, def: 2, value: 5 }));
      p("board", 1, mk("def", "", { atk: 9, def: 9 })); // only the opponent's character exists
    }));
    sess.command(0, { do: "attack", attacker: "spin", target: "def" });
    expect(sess.state.discard).not.toContain("spin");
    expect(M.player(sess.state, 1).board).toContain("spin"); // covers the opponent's character — on THEIR board
    expect(M.player(sess.state, 1).board).not.toContain("def");
    expect(sess.state.instances["spin"]?.overlays).toContain("def");
  });
});

describe("MJG-C22 KALN — Sakurai Shouichi (Faith)", () => {
  it("top 'Guren': Special Summon by overlaying it on a character with no [Type] tag", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("saku", "MJG-C22", { atk: 7, def: 5, value: 3, tribes: ["Schizo"] }));
      p("board", 0, mk("blank", "", { atk: 1, def: 1, tribes: [] })); // no [Type] tag
    }));
    sess.command(0, { do: "activate", iid: "saku", role: "top", targets: ["blank"] });
    expect(M.player(sess.state, 0).board).toContain("saku"); // Special Summoned
    expect(M.player(sess.state, 0).board).not.toContain("blank"); // tucked beneath
    expect(sess.state.instances["saku"]?.overlays).toContain("blank");
  });

  it("top: not offered against a character that HAS a [Type] tag", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("saku", "MJG-C22", { atk: 7, def: 5, value: 3, tribes: ["Schizo"] }));
      p("board", 0, mk("furry", "", { atk: 1, def: 1, tribes: ["Furry"] }));
    }));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "saku" && a.role === "top")).toBe(false);
  });

  it("Heaven's Gate: while a live Sakurai is on a board, a [Type]-less character is considered [Schizo]", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("saku", "MJG-C22", { atk: 7, def: 5, value: 3, tribes: ["Schizo"] }));
      p("board", 1, mk("blank", "", { atk: 1, def: 1, tribes: [] }));
    }));
    expect(M.heavensGateActive(sess.state)).toBe(true);
    expect(M.tribesOf(sess.state, "blank")).toEqual(["Schizo"]); // considered Schizo
    // flip Sakurai face-down -> the aura turns off
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, saku: { ...sess.state.instances["saku"]!, faceDown: true } } });
    expect(M.heavensGateActive(sess.state)).toBe(false);
    expect(M.tribesOf(sess.state, "blank")).toEqual([]); // no longer considered Schizo
  });

  it("Antipsychotics negates Sakurai (itself a [Schizo]), turning Heaven's Gate off", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("saku", "MJG-C22", { atk: 7, def: 5, value: 3, tribes: ["Schizo"] }));
      p("board", 0, mk("meds", "MJG-035", { atk: 1, def: 1, tribes: ["Hag"] })); // Antipsychotics
      p("board", 1, mk("blank", "", { atk: 4, def: 4, tribes: [] }));
    }));
    expect(M.heavensGateActive(sess.state)).toBe(false); // Sakurai's effect is negated
    expect(M.tribesOf(sess.state, "blank")).toEqual([]); // so not considered Schizo
    expect(M.statOf(sess.state, "blank", "atk")).toBe(4); // and not zeroed by Antipsychotics
  });

  it("Heaven's Gate leave-play wipe: when the last Sakurai leaves play, all current [Schizo] characters are discarded", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("saku", "MJG-C22", { atk: 2, def: 2, value: 3, tribes: ["Schizo"] })); // a weak Sakurai that loses
      p("board", 0, mk("schi", "", { atk: 1, def: 1, tribes: ["Schizo"] })); // a real [Schizo]
      p("board", 0, mk("blank", "", { atk: 1, def: 1, tribes: [] })); // considered [Schizo] (no [Type] tag)
      p("board", 0, mk("furry", "", { atk: 1, def: 1, tribes: ["Furry"] })); // has a [Type] tag -> survives
      p("board", 1, mk("def", "", { atk: 9, def: 9, tribes: ["Furry"] }));
    }));
    sess.state = M.replace(sess.state, { heavensGateLatch: true }); // Sakurai is present -> latch armed
    sess.command(0, { do: "attack", attacker: "saku", target: "def" });
    expect(M.player(sess.state, 0).board).not.toContain("saku"); // lost the battle -> left play
    expect(sess.state.discard).toContain("schi"); // a [Schizo] -> discarded
    expect(sess.state.discard).toContain("blank"); // considered [Schizo] -> discarded
    expect(M.player(sess.state, 0).board).toContain("furry"); // has a [Type] tag -> survives
    expect(M.player(sess.state, 1).board).toContain("def"); // [Furry] -> survives
  });
});

describe("MJG-C23 ILYA — Strawberry Cup (Faith)", () => {
  it("top 'Summon - Berserker': overlay onto a character you control; gains its ATK", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("straw", "MJG-C23", { atk: 1, def: 1, value: 1 }));
      p("board", 0, mk("beef", "", { atk: 6, def: 2 })); // a character you control
    }));
    sess.command(0, { do: "activate", iid: "straw", role: "top", targets: ["beef"] });
    expect(M.player(sess.state, 0).board).toContain("straw"); // Special Summoned
    expect(M.player(sess.state, 0).board).not.toContain("beef"); // tucked beneath
    expect(sess.state.instances["straw"]?.overlays).toContain("beef");
    expect(M.atkOf(sess.state, "straw")).toBe(1 + 6); // gains the overlaid card's ATK
  });

  it("top: not offered against a character you do NOT control", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("straw", "MJG-C23", { atk: 1, def: 1, value: 1 }));
      p("board", 1, mk("enemy", "", { atk: 6, def: 2 })); // the opponent's character
    }));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "straw" && a.role === "top")).toBe(false);
  });

  it("bottom 'Class Card': reveal a hand card with an input-free Active, use it, and attach it as an overlay", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("straw", "MJG-C23", { atk: 1, def: 1, value: 1 }));
      p("hand", 0, mk("wash", "MJG-C14", { atk: 7, def: 5, value: 6 })); // bottom "WASHI NO IIPIN" draws 12
    }));
    const hand0 = M.player(sess.state, 0).hand.length;
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "straw", role: "bottom" }); // Class Card
    sess.choose(0, { use: true, target: "wash" }); // reveal the card whose Active to copy
    const drawn = Math.min(12, deck0);
    expect(M.player(sess.state, 0).hand).not.toContain("wash"); // it left the hand
    expect(sess.state.instances["straw"]?.overlays).toContain("wash"); // attached as an overlay
    expect(M.player(sess.state, 0).hand.length).toBe(hand0 - 1 + drawn); // the copied Active drew 12
    expect(M.atkOf(sess.state, "straw")).toBe(1 + 7); // Strawberry gains the overlaid card's ATK
  });

  it("bottom 'Class Card': borrows a target-requiring Active, gathering its target at resolution", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("straw", "MJG-C23", { atk: 1, def: 1, value: 1 }));
      p("hand", 0, mk("snek", "MJG-048", { atk: 2, def: 2, value: 8 })); // bottom "Snake Bite": poison an opponent
    }));
    sess.command(0, { do: "activate", iid: "straw", role: "bottom" });
    sess.choose(0, { use: true, target: "snek" }); // reveal the card to copy
    sess.choose(0, { use: true, target: "1" }); // Snake Bite needs an opponent target
    expect(M.player(sess.state, 1).counters["poison"]).toBe(1); // the borrowed Active ran
    expect(sess.state.instances["straw"]?.overlays).toContain("snek"); // attached
    expect(M.atkOf(sess.state, "straw")).toBe(1 + 2); // gains snek's ATK
  });

  it("bottom 'Class Card': not offered without a hand card that has an Active ability", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("straw", "MJG-C23", { atk: 1, def: 1, value: 1 }));
      p("hand", 0, mk("vanilla", "", { atk: 3, def: 3 })); // no abilities
    }));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "straw" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-C25 KURO — Chocolate Cup (Faith)", () => {
  it("top 'Twin Personality': overlay onto a character you control; gains its ATK and DEF", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("choc", "MJG-C25", { atk: 1, def: 1, value: 3 }));
      p("board", 0, mk("beef", "", { atk: 6, def: 4 }));
    }));
    sess.command(0, { do: "activate", iid: "choc", role: "top", targets: ["beef"] });
    expect(M.player(sess.state, 0).board).toContain("choc"); // Special Summoned
    expect(M.player(sess.state, 0).board).not.toContain("beef"); // tucked beneath
    expect(sess.state.instances["choc"]?.overlays).toContain("beef");
    expect(M.atkOf(sess.state, "choc")).toBe(1 + 6); // gains ATK
    expect(M.defOf(sess.state, "choc")).toBe(1 + 4); // and DEF
  });

  it("Twin Personality: gains and can USE an overlaid card's Active ability", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("choc", "MJG-C25", { atk: 1, def: 1, value: 3 }))));
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances,
        wash: mk("wash", "MJG-C14", { atk: 7, def: 5, value: 6 }), // its bottom "WASHI NO IIPIN" draws 12
        choc: { ...sess.state.instances["choc"]!, overlays: ["wash"] },
      },
    });
    const deck0 = sess.state.mainDeck.length;
    const hand0 = M.player(sess.state, 0).hand.length;
    // Chocolate offers the overlaid card's board Active, tagged with `as`
    const act = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "choc" && a.role === "bottom" && a.as === "MJG-C14");
    expect(act).toBeTruthy();
    sess.command(0, { do: "activate", iid: "choc", role: "bottom", as: "MJG-C14" });
    expect(M.player(sess.state, 0).hand.length).toBe(hand0 + Math.min(12, deck0)); // the gained Active drew 12
    expect(M.atkOf(sess.state, "choc")).toBe(1 + 7); // and it gains wash's ATK
  });

  it("Twin Personality: gains an overlaid card's continuous aura (Tyrant's Hand: +ATK per banished card)", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("choc", "MJG-C25", { atk: 1, def: 1, value: 3 }))));
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances,
        tyr: mk("tyr", "MJG-022", { atk: 0, def: 0, value: 5 }), // "Tyrant's Hand": +1 ATK / -1 VALUE per banished card
        choc: { ...sess.state.instances["choc"]!, overlays: ["tyr"] },
        b1: mk("b1"), b2: mk("b2"),
      },
      banish: ["b1", "b2"],
    });
    // base 1 + overlaid tyr ATK 0 (Twin Personality) + Tyrant's Hand aura (+2 = banish count)
    expect(M.atkOf(sess.state, "choc")).toBe(1 + 0 + 2);
  });

  it("bottom 'Mana Extraction': may attach a battle loser as an overlay instead of discarding it", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("choc", "MJG-C25", { atk: 5, def: 5, value: 3 })); // Chocolate attacks and wins
      p("board", 1, mk("prey", "", { atk: 1, def: 1 }));
    }));
    sess.command(0, { do: "attack", attacker: "choc", target: "prey" });
    expect(sess.viewFor(0).choice).toBeTruthy(); // Mana Extraction prompts the controller
    sess.choose(0, { use: true });
    expect(sess.state.discard).not.toContain("prey"); // not discarded
    expect(sess.state.instances["choc"]?.overlays).toContain("prey"); // attached as an overlay
    expect(M.atkOf(sess.state, "choc")).toBe(5 + 1); // gains prey's ATK
  });

  it("bottom 'Mana Extraction': declining discards the loser normally", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("choc", "MJG-C25", { atk: 5, def: 5, value: 3 }));
      p("board", 1, mk("prey", "", { atk: 1, def: 1 }));
    }));
    sess.command(0, { do: "attack", attacker: "choc", target: "prey" });
    sess.choose(0, { use: false });
    expect(sess.state.discard).toContain("prey"); // discarded normally
    expect(sess.state.instances["choc"]?.overlays ?? []).not.toContain("prey");
  });

  it("bottom 'Mana Extraction': does NOT prompt when Chocolate Cup dies in the same battle", () => {
    // mutual destruction: choc.atk > prey.def AND prey.atk > choc.def; different-parity VALUE
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("choc", "MJG-C25", { atk: 5, def: 1, value: 3 }));
      p("board", 1, mk("prey", "", { atk: 5, def: 1, value: 2 }));
    }));
    sess.command(0, { do: "attack", attacker: "choc", target: "prey" });
    expect(sess.viewFor(0).choice?.effectId).not.toBe("MJG-C25:bottom"); // no attach prompt — she didn't survive
    expect(sess.state.discard).toContain("choc"); // both discarded by the mutual battle
    expect(sess.state.discard).toContain("prey");
  });
});

describe("MJG-C24 MIYU — Vanilla Cup (Faith)", () => {
  it("top 'Summon - Caster': overlay onto a character you control; gains its DEF (only)", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("van", "MJG-C24", { atk: 1, def: 1, value: 2 }));
      p("board", 0, mk("wall", "", { atk: 2, def: 6 }));
    }));
    sess.command(0, { do: "activate", iid: "van", role: "top", targets: ["wall"] });
    expect(M.player(sess.state, 0).board).toContain("van"); // Special Summoned
    expect(M.player(sess.state, 0).board).not.toContain("wall"); // tucked beneath
    expect(sess.state.instances["van"]?.overlays).toContain("wall");
    expect(M.defOf(sess.state, "van")).toBe(1 + 6); // gains DEF
    expect(M.atkOf(sess.state, "van")).toBe(1); // ATK unchanged (Caster gains only DEF)
  });

  it("bottom 'Holy Grail': attach a non-effect character (cost), then search the deck and Special Summon a card", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("van", "MJG-C24", { atk: 1, def: 1, value: 2 }));
      p("hand", 0, mk("tok", "", { atk: 2, def: 3 })); // a non-effect character (no abilities)
    }));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, grail: mk("grail", "", { atk: 4, def: 4 }) },
      mainDeck: ["grail", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "van", role: "bottom" });
    // the attach-cost picker uses the standard hand-click UI ("Select" button on the card)
    expect(sess.viewFor(0).choice?.handPick).toBe("select");
    expect((sess.viewFor(0).choice?.options ?? []).map((o) => o.zone)).toContain("hand");
    sess.choose(0, { use: true, target: "tok" }); // the attach cost
    sess.choose(0, { use: true, target: "grail" }); // search the deck
    expect(sess.state.instances["van"]?.overlays).toContain("tok"); // attached as an overlay
    expect(M.player(sess.state, 0).hand).not.toContain("tok"); // it left the hand
    expect(M.player(sess.state, 0).board).toContain("grail"); // the searched card is Special Summoned
    expect(sess.state.mainDeck).not.toContain("grail");
    expect(M.defOf(sess.state, "van")).toBe(1 + 3); // and Vanilla gains the overlaid token's DEF
  });

  it("bottom 'Holy Grail': not offered without a non-effect character to attach", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("van", "MJG-C24", { atk: 1, def: 1, value: 2 }))));
    // hand holds only an EFFECT card -> no non-effect character anywhere
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, eff: mk("eff", "MJG-C24") },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["eff"] } : p)),
    });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "van" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-C26 GILG — Cum Chalice (Faith)", () => {
  it("top 'Hidden in Dorm' is a Brick: cannot be normal/special summoned by the usual means", () => {
    expect(M.canNormalSummon("MJG-C26")).toBe(false);
    expect(M.canSpecialSummon("MJG-C26")).toBe(false); // only "Gate of Babyron" summons it (test below)
  });

  it("bottom 'Gate of Babyron': summon the whole hand (each attacks), then bounce all but Cum Chalice and end the turn", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("chalice", "MJG-C26", { atk: 1, def: 1, value: 4 }));
      p("hand", 0, mk("strong", "", { atk: 5, def: 5 }));
      p("board", 1, mk("d1", "", { atk: 0, def: 0 }));
      p("board", 1, mk("d2", "", { atk: 0, def: 0 }));
    }));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["chalice", "strong"] } : p)) });
    sess.command(0, { do: "activate", iid: "chalice", role: "bottom" });
    // Cum Chalice is summoned first and attacks (the Brick is summoned by its own Spell)
    expect(M.player(sess.state, 0).board).toContain("chalice");
    sess.choose(0, { use: true, target: "d1" }); // chalice (ATK 1) beats d1 (DEF 0)
    // then "strong" is summoned and attacks
    sess.choose(0, { use: true, target: "d2" }); // strong (ATK 5) beats d2 (DEF 0)
    expect(sess.state.discard).toContain("d1");
    expect(sess.state.discard).toContain("d2");
    // the rampage over: everything except Cum Chalice returns to hand, then the turn ends
    expect(M.player(sess.state, 0).board).toEqual(["chalice"]);
    expect(M.player(sess.state, 0).hand).toContain("strong");
    expect(M.player(sess.state, 0).hand).not.toContain("chalice");
    expect(sess.state.phase).toBe(M.Phase.TURN_END);
  });

  it("bottom 'Gate of Babyron': a summoned card with no legal target doesn't attack", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("chalice", "MJG-C26", { atk: 1, def: 1, value: 4 }))));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["chalice"] } : p)) });
    sess.command(0, { do: "activate", iid: "chalice", role: "bottom" }); // seat 1 has no board -> nothing to attack
    expect(sess.viewFor(0).choice).toBeNull(); // no attack prompt
    expect(M.player(sess.state, 0).board).toContain("chalice"); // still summoned
    expect(M.player(sess.state, 0).hand).not.toContain("chalice");
    expect(sess.state.phase).toBe(M.Phase.TURN_END); // turn ended immediately
  });
});

describe("MJG-WAN WANJ — Mistakes into Miracles (Faith)", () => {
  it("top 'Knot': Special Summon by discarding cards (hand and/or board) totaling exactly 6 ATK and 9 DEF", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("wan", "MJG-WAN", { atk: 6, def: 9, value: 1 }));
      p("hand", 0, mk("c1", "", { atk: 4, def: 6 }));
      p("hand", 0, mk("dud", "", { atk: 1, def: 1 })); // can't be part of a valid 6/9 subset
      p("board", 0, mk("c2", "", { atk: 2, def: 3 }));
    }));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["wan", "c1", "dud"] } : p)) });
    sess.command(0, { do: "activate", iid: "wan", role: "top" });
    // only cards that keep a valid (6 ATK, 9 DEF) total reachable are offered — "dud" is not
    expect(sess.viewFor(0).choice?.options.map((o) => o.iid).sort()).toEqual(["c1", "c2"]);
    // the pick is the standard card-click UI: hand candidates get the "Select" button,
    // the board candidate is clicked directly (zone "board" -> field highlight)
    expect(sess.viewFor(0).choice?.handPick).toBe("select");
    expect(sess.viewFor(0).choice?.options.find((o) => o.iid === "c2")?.zone).toBe("board");
    sess.choose(0, { use: true, target: "c1" }); // ATK 4 / DEF 6
    sess.choose(0, { use: true, target: "c2" }); // ATK 2 / DEF 3 -> totals exactly 6 / 9
    expect(M.player(sess.state, 0).board).toContain("wan"); // Special Summoned
    expect(sess.state.discard).toContain("c1"); // hand cost discarded
    expect(sess.state.discard).toContain("c2"); // board cost discarded
    expect(M.player(sess.state, 0).hand).toContain("dud"); // the dud stayed in hand
  });

  it("top 'Knot': not offered without a discard subset totaling 6 ATK and 9 DEF", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("wan", "MJG-WAN", { atk: 6, def: 9, value: 1 }));
      p("hand", 0, mk("x", "", { atk: 6, def: 6 })); // DEF can't reach 9
    }));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["wan", "x"] } : p)) });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "wan" && a.role === "top")).toBe(false);
  });

  it("bottom 'Itadakimasu': Special Summon every card in the banish pile", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("wan", "MJG-WAN", { atk: 6, def: 9, value: 1 }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, b1: mk("b1", "", { atk: 2, def: 2 }), b2: mk("b2", "", { atk: 3, def: 3 }) },
      banish: ["b1", "b2"],
    });
    sess.command(0, { do: "activate", iid: "wan", role: "bottom" });
    expect(sess.state.banish).toEqual([]); // the banish pile is emptied
    expect(M.player(sess.state, 0).board).toContain("b1"); // Special Summoned to your board
    expect(M.player(sess.state, 0).board).toContain("b2");
  });

  it("bottom 'Itadakimasu': not offered with an empty banish pile", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("wan", "MJG-WAN", { atk: 6, def: 9, value: 1 }))));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "wan" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-M05 CCEO — CEOofLuckshitting (Faith)", () => {
  it("top 'Monopoly': Special Summon this card, draw 5, then immediately end your turn", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("ceo", "MJG-M05", { atk: 5, def: 5, value: 5 }))));
    const deck0 = sess.state.mainDeck.length;
    const hand0 = M.player(sess.state, 0).hand.length; // the turn-draw + ceo
    sess.command(0, { do: "activate", iid: "ceo", role: "top" });
    expect(M.player(sess.state, 0).board).toContain("ceo"); // Special Summoned
    expect(M.player(sess.state, 0).hand.length).toBe(hand0 - 1 + 5); // ceo left the hand; drew 5
    expect(sess.state.mainDeck.length).toBe(deck0 - 5);
    expect(sess.state.phase).toBe(M.Phase.TURN_END); // the turn ended immediately
  });

  it("bottom 'Minimum Wage': at the start of an opponent's turn, the controller gives 2 cards (2-player)", () => {
    const sess = new GameSession(setup((p) => p("board", 1, mk("ceo", "MJG-M05", { atk: 5, def: 5, value: 5 }))));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, g1: mk("g1"), g2: mk("g2"), g3: mk("g3") },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, hand: ["g1", "g2", "g3"] } : p)),
    });
    sess.command(0, { do: "endTurn" }); sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" }); // seat 1's OWN turn start -> Minimum Wage does not fire
    expect(sess.viewFor(1).choice).toBeNull();
    sess.command(1, { do: "endTurn" }); sess.command(1, { do: "advance" });
    sess.command(0, { do: "draw" }); // seat 0's turn start (an opponent's turn for seat 1) -> fires
    sess.choose(1, { use: true, target: "g1" }); // the giver (seat 1) is prompted
    sess.choose(1, { use: true, target: "g2" });
    expect(M.player(sess.state, 0).hand).toEqual(expect.arrayContaining(["g1", "g2"])); // given to seat 0
    expect(M.player(sess.state, 1).hand).not.toContain("g1");
    expect(M.player(sess.state, 1).hand).not.toContain("g2");
    expect(M.player(sess.state, 1).hand).toContain("g3"); // kept the rest
  });
});

describe("MJG-410 BLOD — Blood Sprout (Faith)", () => {
  it("top 'Tra': discard cards (hand and/or board) totaling exactly 7 ATK — a 0-ATK card is allowed", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("blod", "MJG-410", { atk: 7, def: 0, value: 7 }));
      p("hand", 0, mk("zero", "", { atk: 0, def: 5 })); // 0 ATK (allowed in the cost per the ruling)
      p("board", 0, mk("seven", "", { atk: 7, def: 1 })); // 7 ATK from the board
    }));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["blod", "zero"] } : p)) });
    sess.command(0, { do: "activate", iid: "blod", role: "top" });
    sess.choose(0, { use: true, target: "zero" }); // 0 ATK
    sess.choose(0, { use: true, target: "seven" }); // 7 ATK -> totals exactly 7
    expect(M.player(sess.state, 0).board).toContain("blod"); // Special Summoned
    expect(sess.state.discard).toContain("zero"); // hand cost (0 ATK)
    expect(sess.state.discard).toContain("seven"); // board cost
  });

  it("top 'Tra': not offered without a discard subset totaling 7 ATK", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("blod", "MJG-410", { atk: 7, def: 0, value: 7 }));
      p("hand", 0, mk("big", "", { atk: 8, def: 0 })); // 8 ATK overshoots; no 7-subset
    }));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["blod", "big"] } : p)) });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "blod" && a.role === "top")).toBe(false);
  });

  it("bottom 'Tuorps': at the start of an opponent's turn (after drawing), they discard 1 of their choice", () => {
    const sess = new GameSession(setup((p) => p("board", 1, mk("blod", "MJG-410", { atk: 7, def: 0, value: 7 }))));
    sess.command(0, { do: "endTurn" }); sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" }); // seat 1's OWN turn start -> Tuorps does not fire
    expect(sess.viewFor(1).choice).toBeNull();
    sess.command(1, { do: "endTurn" }); sess.command(1, { do: "advance" });
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, h1: mk("h1"), h2: mk("h2") },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["h1", "h2"] } : p)),
    });
    sess.command(0, { do: "draw" }); // seat 0's turn start (an opponent's turn for seat 1) -> fires
    expect(sess.viewFor(0).choice).toBeTruthy(); // the active player (seat 0) is prompted to discard
    sess.choose(0, { use: true, target: "h1" });
    expect(sess.state.discard).toContain("h1"); // discarded
    expect(M.player(sess.state, 0).hand).toContain("h2"); // only one discarded
  });
});

describe("MJG-C18 BEUD — Blue-Eyes Ultimate Dragon (Faith)", () => {
  it("top 'Polymerization': Special Summon by overlaying it on a Blue-Eyes White Dragon", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("beud", "MJG-C18", { atk: 9, def: 7, value: 8 }));
      p("board", 0, mk("bewd", "LOB-001", { atk: 3, def: 2.5, value: 8 }));
    }));
    sess.command(0, { do: "activate", iid: "beud", role: "top", targets: ["bewd"] });
    expect(M.player(sess.state, 0).board).toContain("beud"); // Special Summoned
    expect(M.player(sess.state, 0).board).not.toContain("bewd"); // tucked beneath
    expect(sess.state.instances["beud"]?.overlays).toContain("bewd");
  });

  it("top 'Polymerization': not offered without a Blue-Eyes White Dragon to overlay onto", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("beud", "MJG-C18", { atk: 9, def: 7, value: 8 }));
      p("board", 0, mk("plain", "", {}));
    }));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "beud" && a.role === "top")).toBe(false);
  });

  it("bottom 'De-Fusion': discard this card FROM HAND; Special Summon up to 3 Blue-Eyes White Dragon from hand/deck/discard", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("beud", "MJG-C18", { atk: 9, def: 7, value: 8 })); // the Spell is played from hand
      p("hand", 0, mk("w1", "LOB-001", { atk: 3, def: 2.5 }));
    }));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, w2: mk("w2", "LOB-001", { atk: 3, def: 2.5 }), w3: mk("w3", "LOB-001", { atk: 3, def: 2.5 }) },
      mainDeck: ["w2", ...sess.state.mainDeck],
      discard: ["w3"],
    });
    sess.command(0, { do: "activate", iid: "beud", role: "bottom" });
    sess.choose(0, { use: true, target: "w1" }); // from hand
    sess.choose(0, { use: true, target: "w2" }); // from the deck
    sess.choose(0, { use: true, target: "w3" }); // from the discard -> 3 picked (the max)
    expect(sess.state.discard).toContain("beud"); // De-Fusion discarded this card
    ["w1", "w2", "w3"].forEach((w) => expect(M.player(sess.state, 0).board).toContain(w)); // all 3 Special Summoned
    expect(sess.state.mainDeck).not.toContain("w2");
    expect(sess.state.discard).not.toContain("w3");
  });

  it("bottom 'De-Fusion': 'up to' 3 — choosing Done summons fewer", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("beud", "MJG-C18", { atk: 9, def: 7, value: 8 }));
      p("hand", 0, mk("w1", "LOB-001", { atk: 3, def: 2.5 }));
      p("hand", 0, mk("w2", "LOB-001", { atk: 3, def: 2.5 }));
    }));
    sess.command(0, { do: "activate", iid: "beud", role: "bottom" });
    sess.choose(0, { use: true, target: "w1" });
    sess.choose(0, { use: true, target: "done" });
    expect(M.player(sess.state, 0).board).toContain("w1");
    expect(M.player(sess.state, 0).hand).toContain("w2"); // left in hand (chose Done)
    expect(sess.state.discard).toContain("beud");
  });

  it("bottom 'De-Fusion': not offered with no Blue-Eyes White Dragon available", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("beud", "MJG-C18", { atk: 9, def: 7, value: 8 }))));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "beud" && a.role === "bottom")).toBe(false);
  });
});

describe("SHA-001 SHAM — Shamiko", () => {
  it("top 'Shamiko Punch': reveal and discard a character with 0 DEF; Shamiko stays in hand", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("sham", "SHA-001", { atk: 1, def: 1, value: 1 })); // ☆ stats (crafted placeholders)
      p("board", 1, mk("weak", "", { atk: 5, def: 0 })); // a 0-DEF character
    }));
    sess.command(0, { do: "activate", iid: "sham", role: "top", targets: ["weak"] });
    expect(sess.state.discard).toContain("weak"); // the 0-DEF character is discarded
    expect(M.player(sess.state, 1).board).not.toContain("weak");
    expect(M.player(sess.state, 0).hand).toContain("sham"); // Shamiko stays in hand (only revealed)
  });

  it("top 'Shamiko Punch': not offered without a 0-DEF character to target", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("sham", "SHA-001", { atk: 1, def: 1, value: 1 }));
      p("board", 1, mk("tank", "", { atk: 1, def: 5 })); // DEF 5 — not a valid target
    }));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "sham" && a.role === "top")).toBe(false);
  });
});

describe("MJG-000 FREE — Freed Jyanshi (Faith)", () => {
  it("top: Special Summon by overlaying it on any character — it lands on that character's owner's board", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("free", "MJG-000", { atk: 0, def: 0, value: 0, tribes: ["Schizo"] }));
      p("board", 1, mk("victim", "", { atk: 1, def: 1 })); // an opponent's character
    }));
    sess.command(0, { do: "activate", iid: "free", role: "top", targets: ["victim"] });
    expect(M.player(sess.state, 1).board).toContain("free"); // lands on the onto-owner's board (seat 1)
    expect(M.player(sess.state, 1).board).not.toContain("victim"); // tucked beneath
    expect(sess.state.instances["free"]?.overlays).toContain("victim");
  });

  it("bottom: the controller cannot Normal Summon or activate effects from hand", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("free", "MJG-000", { atk: 0, def: 0, value: 0, tribes: ["Schizo"] }));
      p("hand", 0, mk("dude", "", { atk: 1, def: 1 })); // a normally-summonable card
      p("hand", 0, mk("spell", "MJG-015")); // a hand Spell (iTunes Gift Card)
    }));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "normalSummon" && a.iid === "dude")).toBe(false);
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "spell")).toBe(false);
    expect(sess.command(0, { do: "summon", iid: "dude" }).ok).toBe(false); // rejected (defence in depth)
  });

  it("bottom: when the controller has 10+ cards in hand, Freed Jyanshi is discarded", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("free", "MJG-000", { atk: 0, def: 0, value: 0, tribes: ["Schizo"] }));
      p("board", 0, mk("host", "", { atk: 1, def: 1 }));
      for (const iid of ten) p("hand", 0, mk(iid));
    }));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["free", ...ten] } : p)) });
    sess.command(0, { do: "activate", iid: "free", role: "top", targets: ["host"] }); // overlay -> free on board, hand drops to 10
    expect(sess.state.discard).toContain("free"); // state-based check discards it (10+ in hand)
    expect(M.player(sess.state, 0).board).not.toContain("free");
  });
});

describe("MSGK-C30 MSGK — Mutsugaki", () => {
  it("top 'Brat': ATK and DEF are 0 during opponents' turns", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("mut", "MSGK-C30", { atk: 5, def: 5, value: 1, tribes: ["Cunny"] }))));
    expect(M.atkOf(sess.state, "mut")).toBe(5); // its controller's turn: full stats
    expect(M.defOf(sess.state, "mut")).toBe(5);
    sess.command(0, { do: "endTurn" }); sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" }); // now an opponent's turn
    expect(M.atkOf(sess.state, "mut")).toBe(0); // ATK and DEF drop to 0
    expect(M.defOf(sess.state, "mut")).toBe(0);
  });

  it("bottom 'Explosive Aria': the placed card blows up everything it touches, then itself", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("mut", "MSGK-C30", { atk: 5, def: 5, value: 1, tribes: ["Cunny"] }));
      p("hand", 0, mk("bomb", "", { atk: 1, def: 1, value: 2 }));
      p("board", 1, mk("v1", "", {})); p("board", 1, mk("v2", "", {})); p("board", 1, mk("far", "", {}));
    }));
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, // pin table spots
      v1: { ...sess.state.instances["v1"]!, pos: { x: 0, y: 0, page: 0 } },
      v2: { ...sess.state.instances["v2"]!, pos: { x: 80, y: 20, page: 0 } },
      far: { ...sess.state.instances["far"]!, pos: { x: 140, y: 0, page: 0 } }, // flush against the drop
    } });
    sess.command(0, { do: "activate", iid: "mut", role: "bottom" });
    expect(sess.viewFor(0).choice?.handPick).toBe("place"); // the usual hand picker
    sess.choose(0, { use: true, target: "bomb" });
    expect(sess.viewFor(0).choice?.placeCard?.iid).toBe("bomb"); // now riding the mouse
    sess.choose(0, { use: true, place: { seat: 1, x: 40, y: 10, page: 0 } }); // rect 40..140 × 10..149
    drainMass(sess); // seat 1 orders the two touched cards; then bomb falls
    expect(sess.state.discard).toEqual(expect.arrayContaining(["v1", "v2", "bomb"]));
    expect(M.player(sess.state, 1).board).toEqual(["far"]); // flush edges do NOT count as touching
    expect(M.player(sess.state, 0).hand).not.toContain("bomb");
    expect(sess.state.instances["mut"]?.tapped).toBe(true);
  });

  it("bottom: touching nothing just discards the placed card; Bricks can't be placed", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("mut", "MSGK-C30", { atk: 5, def: 5, value: 1, tribes: ["Cunny"] }));
      p("hand", 0, mk("bomb", "", { value: 2 }));
      p("hand", 0, mk("brk", "MJG-C16", { value: 4 }));
      p("board", 1, mk("v1", "", {}));
    }));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, v1: { ...sess.state.instances["v1"]!, pos: { x: 0, y: 0, page: 0 } } },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["bomb", "brk"] } : p)), // drop the dealt m-0 filler
    });
    sess.command(0, { do: "activate", iid: "mut", role: "bottom" });
    expect(sess.viewFor(0).choice?.options.map((o) => o.iid)).toEqual(["bomb"]); // the Brick is not offered
    sess.choose(0, { use: true, target: "bomb" });
    sess.choose(0, { use: true, place: { seat: 1, x: 500, y: 0, page: 0 } }); // open space
    expect(sess.state.discard).toContain("bomb"); // only itself blows up
    expect(M.player(sess.state, 1).board).toEqual(["v1"]);
  });

  it("bottom: not activatable with only Bricks in hand", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("mut", "MSGK-C30", { atk: 5, def: 5, value: 1, tribes: ["Cunny"] }));
      p("hand", 0, mk("brk", "MJG-C16", { value: 4 }));
    }));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["brk"] } : p)) }); // drop the dealt m-0 filler
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "mut" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-C29 ARU — DealinDemon", () => {
  it("top 'Gravity of a Boss': when it attacks, the defender doesn't fight back (no counter)", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("aru", "MJG-C29", { atk: 8, def: 1, value: 6, tribes: ["Hag"] }));
      p("board", 1, mk("n1", "", { atk: 1, def: 1 }));
      p("board", 1, mk("wall", "", { atk: 9, def: 100 })); // ATK 9 would kill aru (DEF 1), but Gravity stops it
      p("board", 1, mk("n2", "", { atk: 1, def: 1 }));
    }));
    sess.command(0, { do: "attack", attacker: "aru", target: "wall" });
    expect(M.player(sess.state, 0).board).toContain("aru"); // survives — the defender didn't fight back
    expect(M.player(sess.state, 1).board).toContain("wall"); // wall survives too (aru ATK 8 <= DEF 100)
  });

  it("bottom 'Noir Attack': after it attacks, discards the 2 characters closest to the original target", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("aru", "MJG-C29", { atk: 8, def: 1, value: 6, tribes: ["Hag"] }));
      p("board", 1, mk("a", "", { atk: 1, def: 1 }));
      p("board", 1, mk("tgt", "", { atk: 1, def: 1 })); // the attack target
      p("board", 1, mk("b", "", { atk: 1, def: 1 }));
      p("board", 1, mk("far", "", { atk: 1, def: 1 }));
    }));
    sess.command(0, { do: "attack", attacker: "aru", target: "tgt" });
    drainMass(sess); // seat 1 orders its own Noir Attack losses
    expect(sess.state.discard).toContain("tgt"); // beaten by the battle (no counter)
    expect(sess.state.discard).toContain("a"); // flush beside the target -> closest
    expect(sess.state.discard).toContain("b");
    expect(M.player(sess.state, 1).board).toContain("far"); // a slot farther -> survives
  });

  it("bottom 'Noir Attack': flush neighbours beat a card straight across on the attacker's board", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("aru", "MJG-C29", { atk: 8, def: 1, value: 6, tribes: ["Hag"] })); // attacker col 0
      p("board", 0, mk("axx", "", { atk: 1, def: 1 })); // attacker col 1 — same column as the target (distance 1)
      p("board", 1, mk("oppL", "", { atk: 1, def: 1 })); // col 0 (distance 1)
      p("board", 1, mk("tgt", "", { atk: 1, def: 1 })); // col 1 (target)
      p("board", 1, mk("oppR", "", { atk: 1, def: 1 })); // col 2 (distance 1)
    }));
    sess.command(0, { do: "attack", attacker: "aru", target: "tgt" });
    drainMass(sess); // owners order their own losses
    // oppL/oppR sit flush beside the target (100 apart); axx is a full board row away
    expect(sess.state.discard).toContain("oppL");
    expect(sess.state.discard).toContain("oppR");
    expect(M.player(sess.state, 0).board).toContain("axx"); // attacker's card is farther across the table
  });

  it("bottom 'Noir Attack': pages sit one card-width apart on an infinitely wide strip", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("aru", "MJG-C29", { atk: 8, def: 1, value: 6, tribes: ["Hag"] }));
      p("board", 1, mk("tgt", "", { atk: 1, def: 1 }));
      p("board", 1, mk("near", "", { atk: 1, def: 1 }));
      p("board", 1, mk("edge", "", { atk: 1, def: 1 }));
      p("board", 1, mk("pg1", "", { atk: 1, def: 1 }));
    }));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, // centre-to-centre from tgt (0,0):
        tgt: { ...sess.state.instances["tgt"]!, pos: { x: 0, y: 0, page: 0 } },
        near: { ...sess.state.instances["near"]!, pos: { x: 300, y: 0, page: 0 } }, // 300
        edge: { ...sess.state.instances["edge"]!, pos: { x: 660, y: 0, page: 0 } }, // 660
        pg1: { ...sess.state.instances["pg1"]!, pos: { x: 0, y: 0, page: 1 } }, // 860: a page away
        aru: { ...sess.state.instances["aru"]!, pos: { x: 660, y: 105, page: 0 } }, // ~674 across the boards
      },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, boardPages: 2 } : p)),
    });
    sess.command(0, { do: "attack", attacker: "aru", target: "tgt" });
    drainMass(sess); // seat 1 orders its own losses
    expect(sess.state.discard).toContain("near");
    expect(sess.state.discard).toContain("edge"); // same page, 660 away — still beats the page hop
    expect(M.player(sess.state, 1).board).toContain("pg1"); // one page over = 860 away
    expect(M.player(sess.state, 0).board).toContain("aru"); // ~674 — third closest, survives
  });

  it("bottom 'Noir Attack': board rows are measured from the ATTACKER's perspective (3p)", () => {
    let st = M.newGame({ players: [0, 1, 2], mainDeck: 30, startingHand: 0, cardRegistry: baseSet });
    st = M.reduce(st, { type: M.ActionType.DRAW_RESOLVES });
    const sess = new GameSession(st);
    const pin = (iid: string, ci: M.CardInstance, pid: number, pos: { x: number; y: number; page: number }) => {
      sess.state = M.replace(sess.state, {
        instances: { ...sess.state.instances, [iid]: { ...ci, pos } },
        players: sess.state.players.map((p) => (p.pid === pid ? { ...p, board: [...p.board, iid] } : p)),
      });
    };
    pin("aru", mk("aru", "MJG-C29", { atk: 8, def: 1, value: 6, tribes: ["Hag"] }), 0, { x: 0, y: 0, page: 0 });
    pin("tgt", mk("tgt", "", { atk: 1, def: 1 }), 1, { x: 0, y: 0, page: 0 });
    pin("far", mk("far", "", { atk: 1, def: 1 }), 1, { x: 400, y: 0, page: 0 });
    pin("c2", mk("c2", "", { atk: 1, def: 1 }), 2, { x: 0, y: 0, page: 0 });
    sess.command(0, { do: "attack", attacker: "aru", target: "tgt" });
    drainMass(sess); // each victim's owner orders their own
    // from seat 0's view: seat 2 is one row away, seat 1 two — so seat 2's card (244)
    // and the same-board far card (400) beat DealinDemon itself (488 straight down)
    expect(sess.state.discard).toEqual(expect.arrayContaining(["tgt", "c2", "far"]));
    expect(M.player(sess.state, 0).board).toContain("aru");
  });
});

describe("MJG-117633 — June 4th Incident (Faith)", () => {
  it("top 'How did he know?': form a serial code, search the Main Deck for the match, add it + SS this", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("june4", "MJG-117633", { atk: 0, def: 4, value: 6 }));
      p("hand", 0, mk("v1", "", { value: 1 }));
      p("hand", 0, mk("v3", "", { value: 3 }));
    }));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, t13: mk("t13", "MJG-013", { value: 1 }) },
      mainDeck: ["t13", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "june4", role: "top" });
    sess.choose(0, { use: true, target: "t13" }); // code "013" = wild(0) + v1(1) + v3(3)
    // then the player picks WHICH cards to reveal (hand-click prompt, viable ones only)
    expect(sess.viewFor(0).choice?.handPick).toBe("reveal");
    sess.choose(0, { use: true, target: "v1" });
    sess.choose(0, { use: true, target: "v3" });
    expect(M.player(sess.state, 0).hand).toContain("t13"); // searched and added to hand
    expect(sess.state.mainDeck).not.toContain("t13");
    expect(M.player(sess.state, 0).board).toContain("june4"); // "if you do, Special Summon this card"
    expect(M.player(sess.state, 0).hand).not.toContain("june4");
  });

  it("top: June 4th is wild — it can supply a letter (the 'C' in code C18)", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("june4", "MJG-117633", { atk: 0, def: 4, value: 6 }));
      p("hand", 0, mk("v1", "", { value: 1 }));
      p("hand", 0, mk("v8", "", { value: 8 }));
    }));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, c18: mk("c18", "MJG-C18", { value: 1 }) },
      mainDeck: ["c18", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "june4", role: "top" });
    sess.choose(0, { use: true, target: "c18" }); // "C18" = wild(C) + v1(1) + v8(8)
    sess.choose(0, { use: true, target: "v1" });
    sess.choose(0, { use: true, target: "v8" });
    expect(M.player(sess.state, 0).hand).toContain("c18");
    expect(M.player(sess.state, 0).board).toContain("june4");
  });

  it("top: ☆ cards are wild too (supply the 0s for code 000)", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("june4", "MJG-117633", { atk: 0, def: 4, value: 6 }));
      p("hand", 0, mk("s1", "", { value: null }));
      p("hand", 0, mk("s2", "", { value: null }));
    }));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, t000: mk("t000", "MJG-000", { value: null }) },
      mainDeck: ["t000", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "june4", role: "top" });
    sess.choose(0, { use: true, target: "t000" }); // "000" = wild + ☆ + ☆
    sess.choose(0, { use: true, target: "s1" });
    sess.choose(0, { use: true, target: "s2" });
    expect(M.player(sess.state, 0).hand).toContain("t000");
    expect(M.player(sess.state, 0).board).toContain("june4");
  });

  it("top: only VIABLE reveals are offered for the added card's code (and picked ones outlined)", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("june4", "MJG-117633", { atk: 0, def: 4, value: 6 }));
      p("hand", 0, mk("v1", "", { value: 1 }));
      p("hand", 0, mk("v3", "", { value: 3 }));
      p("hand", 0, mk("v7", "", { value: 7 })); // 7 fits nowhere in code "013"
    }));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, t13: mk("t13", "MJG-013", { value: 1 }) },
      mainDeck: ["t13", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "activate", iid: "june4", role: "top" });
    sess.choose(0, { use: true, target: "t13" }); // code "013"
    // first reveal: v7 is NOT offered (no partner completes 013 with it); the dealt
    // opaque m-0 (VALUE 0) legitimately supplies the code's 0, so it IS offered
    let opts = (sess.viewFor(0).choice?.options ?? []).map((o) => o.iid);
    expect(opts).not.toContain("v7");
    expect(opts.sort()).toEqual(["m-0", "v1", "v3"]);
    sess.choose(0, { use: true, target: "v1" });
    // second reveal: v1 is shown as picked; completions with v1 are v3 (*→0) and m-0 (*→3)
    expect(sess.viewFor(0).choice?.picked).toEqual(["v1"]);
    opts = (sess.viewFor(0).choice?.options ?? []).map((o) => o.iid);
    expect(opts).not.toContain("v7");
    expect(opts.sort()).toEqual(["m-0", "v3"]);
    sess.choose(0, { use: true, target: "v3" });
    expect(M.player(sess.state, 0).hand).toContain("t13");
    expect(M.player(sess.state, 0).board).toContain("june4");
    expect(M.player(sess.state, 0).hand).toContain("v7"); // untouched
  });

  it("top: not offered when no Main Deck card's serial code can be formed", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("june4", "MJG-117633", { atk: 0, def: 4, value: 6 }));
      p("hand", 0, mk("v1", "", { value: 1 }));
      p("hand", 0, mk("v2", "", { value: 2 }));
    }));
    sess.state = M.replace(sess.state, { mainDeck: [] }); // nothing to search
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "june4" && a.role === "top")).toBe(false);
  });
});

describe("NYA-999 CBOX — Catbox (Extra Zone)", () => {
  const uploadCatbox = () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("catbox", "NYA-999", { atk: 1, def: 1, value: 1 }));
      p("hand", 0, mk("nyag", "MJG-001", { atk: 1, def: 1 })); // non-Faith, has a board Active (SS top of deck)
    }));
    sess.command(0, { do: "activate", iid: "catbox", role: "top" });
    sess.choose(0, { use: true, target: "nyag" });
    return sess;
  };

  it("top 'Upload': place Catbox + a non-Faith card (with an Active) in the Extra Zone", () => {
    const sess = uploadCatbox();
    expect(sess.state.extraZone).toEqual(expect.arrayContaining(["catbox", "nyag"]));
    expect(M.player(sess.state, 0).hand).not.toContain("catbox");
    expect(M.player(sess.state, 0).hand).not.toContain("nyag");
    // the zone is public in every seat's view (rendered left of the Main deck)
    expect(sess.viewFor(0).extraZone.map((c) => c.iid)).toEqual(expect.arrayContaining(["catbox", "nyag"]));
    expect(sess.viewFor(1).extraZone.map((c) => c.iid)).toEqual(expect.arrayContaining(["catbox", "nyag"]));
  });

  it("Extra Zone: every player can use the uploaded Active once per turn, on their turn", () => {
    const sess = uploadCatbox();
    // seat 0 (active) uses it: Special Summon the top of the deck to THEIR board
    const top0 = sess.state.mainDeck[0]!;
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "nyag" && a.role === "bottom")).toBe(true);
    sess.command(0, { do: "activate", iid: "nyag", role: "bottom" });
    expect(M.player(sess.state, 0).board).toContain(top0);
    // once per turn: not offered again to seat 0 this turn
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "nyag" && a.role === "bottom")).toBe(false);
    // on seat 1's turn, seat 1 may use it too (resolves to THEIR board)
    sess.command(0, { do: "endTurn" }); sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" });
    const top1 = sess.state.mainDeck[0]!;
    expect(sess.viewFor(1).legal.some((a) => a.kind === "activate" && a.iid === "nyag" && a.role === "bottom")).toBe(true);
    sess.command(1, { do: "activate", iid: "nyag", role: "bottom" });
    expect(M.player(sess.state, 1).board).toContain(top1);
  });

  it("top 'Upload': not offered without a non-Faith card that has an Active", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("catbox", "NYA-999", { atk: 1, def: 1, value: 1 }));
      p("hand", 0, mk("faithcard", "MJG-014", { atk: 0, def: 7, value: 7 })); // a Faith-deck card
      p("hand", 0, mk("vanilla", "", {})); // no abilities
    }));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "catbox" && a.role === "top")).toBe(false);
  });
});

describe("MJG-M16 Mixing Magic", () => {
  it("top '1, 2, 3, lets go': SS-able only with EXACTLY 3 characters on your board", () => {
    const mk16 = (boardCount: number) =>
      new GameSession(
        setup((p) => {
          p("hand", 0, mk("mm", "MJG-M16", { atk: 4, def: 4, value: 4 }));
          for (let i = 0; i < boardCount; i++) p("board", 0, mk(`b${i}`));
        }),
      );
    const offered = (sess: GameSession) => sess.viewFor(0).legal.some((x) => x.kind === "activate" && x.iid === "mm" && x.role === "top");
    expect(offered(mk16(2))).toBe(false); // too few
    expect(offered(mk16(4))).toBe(false); // too many
    const sess = mk16(3);
    expect(offered(sess)).toBe(true);
    sess.command(0, { do: "activate", iid: "mm", role: "top" });
    expect(M.player(sess.state, 0).board).toContain("mm"); // Special Summoned
  });

  it("bottom 'c': all players draw UP TO 4 cards in hand, anticlockwise", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("mm", "MJG-M16", { atk: 4, def: 4, value: 4 }))));
    // seat 0: 1 card -> draws 3; seat 1: 2 cards -> draws 2
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, h0: mk("h0"), q1: mk("q1"), q2: mk("q2") },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["h0"] } : { ...p, hand: ["q1", "q2"] })),
    });
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "mm", role: "bottom" });
    expect(M.player(sess.state, 0).hand.length).toBe(4); // 1 -> 4
    expect(M.player(sess.state, 1).hand.length).toBe(4); // 2 -> 4
    expect(sess.state.mainDeck.length).toBe(deck0 - 5); // 3 + 2 drawn
    expect(sess.state.instances["mm"]?.tapped).toBe(true); // using the Active taps it
  });

  it("bottom: a player already at 4+ cards draws nothing (and is NOT made to discard)", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("mm", "MJG-M16", { atk: 4, def: 4, value: 4 }))));
    const five = ["q1", "q2", "q3", "q4", "q5"];
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, ...Object.fromEntries(five.map((i) => [i, mk(i)])) },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, hand: five } : { ...p, hand: [] })),
    });
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "activate", iid: "mm", role: "bottom" });
    expect(M.player(sess.state, 1).hand.length).toBe(5); // unchanged — no draw, no discard
    expect(M.player(sess.state, 0).hand.length).toBe(4); // 0 -> 4
    expect(sess.state.mainDeck.length).toBe(deck0 - 4); // only seat 0 drew
  });
});

describe("KAN (add a matching 4th card to a triplet)", () => {
  /** seat 0: a value-2 triplet meld + the given extras. */
  const kanSetup = (add: (p: (where: "hand" | "board", pid: number, ci: M.CardInstance) => void) => void) => {
    const sess = new GameSession(setup(add));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, x1: mk("x1", "", { value: 2 }), x2: mk("x2", "", { value: 2 }), x3: mk("x3", "", { value: 2 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, meldZone: [{ cards: ["x1", "x2", "x3"], kind: "triplet" as const, kan: false }] } : p)),
    });
    return sess;
  };

  it("a matching face-up board card KANs the meld and draws the deck BOTTOM", () => {
    const sess = kanSetup((p) => {
      p("board", 0, mk("m2", "", { atk: 1, def: 1, value: 2 })); // matches the triplet
      p("board", 0, mk("m7", "", { atk: 1, def: 1, value: 7 })); // doesn't
    });
    const act = sess.viewFor(0).legal.find((a): a is Extract<import("../engine/legal.js").LegalAction, { kind: "kan" }> => a.kind === "kan");
    expect(act).toBeDefined();
    expect(act!.materialIds).toContain("m2");
    expect(act!.materialIds).not.toContain("m7"); // VALUE mismatch
    const bottom = sess.state.mainDeck[sess.state.mainDeck.length - 1]!;
    const r = sess.command(0, { do: "kan", meldIndex: 0, material: "m2" });
    expect(r.ok).toBe(true);
    const meld = M.player(sess.state, 0).meldZone[0]!;
    expect(meld.kan).toBe(true);
    expect(meld.cards).toEqual(["x1", "x2", "x3", "m2"]);
    expect(M.player(sess.state, 0).board).not.toContain("m2");
    expect(M.player(sess.state, 0).hand).toContain(bottom); // KAN draws the BOTTOM
  });

  it("a mismatched material is rejected; no kan action without any valid material", () => {
    const sess = kanSetup((p) => p("board", 0, mk("m7", "", { atk: 1, def: 1, value: 7 })));
    expect(sess.viewFor(0).legal.some((a) => a.kind === "kan")).toBe(false);
    expect(sess.command(0, { do: "kan", meldIndex: 0, material: "m7" }).ok).toBe(false);
  });

  it("Rinshan Kaihou (Cute Boy): KAN from HAND, and the bottom-draw becomes a Faith-deck search", () => {
    let sess = kanSetup((p) => {
      p("board", 0, mk("cute", "MJG-C01", { atk: 0, def: 0, value: 4 }));
      p("hand", 0, mk("h2", "", { value: 2 })); // hand material (Rinshan source)
    });
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, fa: mk("fa", "MJG-014", { value: 1 }), fb: mk("fb", "MJG-016", { value: 1 }) },
      faithDeck: ["fa", "fb"],
    });
    const act = sess.viewFor(0).legal.find((a): a is Extract<import("../engine/legal.js").LegalAction, { kind: "kan" }> => a.kind === "kan");
    expect(act!.materialIds).toContain("h2"); // hand card offered via Rinshan
    const deck0 = sess.state.mainDeck.length;
    sess.command(0, { do: "kan", meldIndex: 0, material: "h2" });
    // the Faith search prompt (chooser-only pick from the Faith deck)
    const ch = sess.viewFor(0).choice;
    expect(ch?.options.map((o) => o.iid).sort()).toEqual(["fa", "fb"]);
    sess.choose(0, { use: true, target: "fb" });
    expect(M.player(sess.state, 0).meldZone[0]!.kan).toBe(true);
    expect(M.player(sess.state, 0).hand).toContain("fb"); // searched, not drawn
    expect(sess.state.faithDeck).not.toContain("fb");
    expect(sess.state.mainDeck.length).toBe(deck0); // NO bottom draw
  });
});

describe("once-per-turn is PER CARD NAME (Twin Personality copies have their own budget)", () => {
  it("Magical Sands melds; Chocolate Cup's granted Second Hand melds AGAIN the same turn", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("sands", "MJG-C13", { atk: 2, def: 2, value: 2 }));
      p("board", 0, mk("choc", "MJG-C25", { atk: 1, def: 1, value: 3 }));
    }));
    const disc = ["v1", "v2", "v3", "w1", "w2", "w3"];
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances,
        ...Object.fromEntries(disc.map((d) => [d, mk(d, "", { value: 2 })])),
        sands2: mk("sands2", "MJG-C13", { atk: 2, def: 2, value: 2 }),
        choc: { ...sess.state.instances["choc"]!, overlays: ["sands2"] }, // Twin Personality grants its abilities
      },
      discard: disc,
    });
    // 1) Magical Sands uses its own Second Hand
    expect(sess.command(0, { do: "activate", iid: "sands", role: "bottom", targets: ["v1", "v2", "v3"] }).ok).toBe(true);
    expect(M.player(sess.state, 0).meldZone.length).toBe(1);
    // its own copy is exhausted for the turn...
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "sands" && a.role === "bottom")).toBe(false);
    // ...but Chocolate Cup's GRANTED copy is a different card name — still available
    const granted = sess.viewFor(0).legal.find((a) => a.kind === "activate" && a.iid === "choc" && a.role === "bottom" && a.as === "MJG-C13");
    expect(granted).toBeDefined();
    expect(sess.command(0, { do: "activate", iid: "choc", role: "bottom", as: "MJG-C13", targets: ["w1", "w2", "w3"] }).ok).toBe(true);
    expect(M.player(sess.state, 0).meldZone.length).toBe(2); // melded again
    // and now the HOST's budget is spent too
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "choc" && a.role === "bottom" && a.as === "MJG-C13")).toBe(false);
  });
});

describe("Twin Personality grants hard-coded PASSIVES too (not just activatables)", () => {
  it("a C25 with Cute Boy overlaid grants Rinshan: KAN offers a HAND material", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("choc", "MJG-C25", { atk: 1, def: 1, value: 3 }));
      p("hand", 0, mk("h2", "", { value: 2 }));
    }));
    sess.state = M.replace(sess.state, {
      instances: {
        ...sess.state.instances,
        cute: mk("cute", "MJG-C01", { atk: 0, def: 0, value: 4 }),
        choc: { ...sess.state.instances["choc"]!, overlays: ["cute"] }, // Twin Personality
        x1: mk("x1", "", { value: 2 }), x2: mk("x2", "", { value: 2 }), x3: mk("x3", "", { value: 2 }),
      },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, meldZone: [{ cards: ["x1", "x2", "x3"], kind: "triplet" as const, kan: false }] } : p)),
    });
    expect(M.controlsRinshan(sess.state, 0)).toBe(true); // granted, not printed
    const act = sess.viewFor(0).legal.find((a): a is Extract<import("../engine/legal.js").LegalAction, { kind: "kan" }> => a.kind === "kan");
    expect(act?.materialIds).toContain("h2"); // hand source only legal via Rinshan
  });

  it("a C25 with Cupid Doesn't Exist overlaid cannot attack (granted lock)", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("choc", "MJG-C25", { atk: 5, def: 5, value: 3 }));
      p("board", 1, mk("prey", "", { atk: 1, def: 1 }));
    }));
    // without the overlay it can attack
    expect(sess.viewFor(0).legal.some((a) => a.kind === "attack" && a.iid === "choc")).toBe(true);
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, cupid: mk("cupid", "MJG-M11", { atk: 1, def: 1 }), choc: { ...sess.state.instances["choc"]!, overlays: ["cupid"] } },
    });
    expect(M.cannotAttack(sess.state, "choc")).toBe(true); // gains the passive
    expect(sess.viewFor(0).legal.some((a) => a.kind === "attack" && a.iid === "choc")).toBe(false);
  });
});

describe("auto toggle: post-resolution windows count as reacting to an opponent", () => {
  it("Shoumakyou (MJG-C04) holder on AUTO is prompted after an opponent's effect resolves", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("ny", "MJG-001", { atk: 1, def: 1, value: 1 }));
      p("hand", 1, mk("c04", "MJG-C04", { atk: 2, def: 2, value: 4 }));
    }));
    sess.setToggle(1, "auto");
    sess.command(0, { do: "activate", iid: "ny", role: "top" }); // Chi on First Turn: SS + draw
    expect(M.player(sess.state, 0).board).toContain("ny"); // the spell resolved
    expect(sess.awaiting).toBe(1); // POST-resolution window: the auto seat is prompted
    expect(sess.viewFor(1).legal.some((a) => a.kind === "activate" && a.iid === "c04" && a.role === "top")).toBe(true);
    const r = sess.respond(1, { activate: { iid: "c04", role: "top" } });
    expect(r.ok).toBe(true);
    expect(sess.state.discard).toContain("c04"); // discarded itself
    expect(sess.state.effectLockBy).toBe(1); // opponents of seat 1 are effect-locked this turn
  });

  it("the holder is NOT prompted after their OWN effect resolves (auto stays quiet)", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("ny", "MJG-001", { atk: 1, def: 1, value: 1 }));
      p("hand", 0, mk("c04", "MJG-C04", { atk: 2, def: 2, value: 4 }));
    }));
    sess.setToggle(0, "auto");
    sess.command(0, { do: "activate", iid: "ny", role: "top" });
    expect(M.player(sess.state, 0).board).toContain("ny");
    expect(sess.awaiting).toBeNull(); // your own resolution isn't a reaction for auto
  });
});

describe("Free mode (dev sandbox): direct zone manipulation, no limits", () => {
  it("summon is unlimited and ignores the once-per-turn cap; meld can use ANY visible cards", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("h1", "MJG-011", { value: 2 }));
      p("hand", 0, mk("h2", "MJG-013", { value: 2 }));
      p("board", 1, mk("opp2", "", { atk: 1, def: 1, value: 2 })); // an opponent's face-up card
    }));
    expect(sess.free(0, { do: "summon", iid: "h1" }).ok).toBe(true);
    expect(sess.free(0, { do: "summon", iid: "h2" }).ok).toBe(true); // second summon, same turn
    expect(M.player(sess.state, 0).board).toEqual(expect.arrayContaining(["h1", "h2"]));
    // free meld: two of my board cards + the OPPONENT's visible card (all value 2 -> triplet)
    expect(sess.free(0, { do: "meld", materials: ["h1", "h2", "opp2"] }).ok).toBe(true);
    const mz = M.player(sess.state, 0).meldZone;
    expect(mz.length).toBe(1);
    expect(mz[0]!.kind).toBe("triplet");
    expect(M.player(sess.state, 1).board).not.toContain("opp2"); // pulled from their board
  });

  it("discard / banish / to-hand / to-deck+shuffle work on any visible card", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 1, mk("a", "", { atk: 1, def: 1 }));
      p("board", 1, mk("b", "", { atk: 1, def: 1 }));
      p("hand", 0, mk("mine", "MJG-011"));
    }));
    expect(sess.free(0, { do: "discard", iid: "a" }).ok).toBe(true);
    expect(sess.state.discard[0]).toBe("a");
    expect(sess.free(0, { do: "banish", iid: "b" }).ok).toBe(true);
    expect(sess.state.banish).toContain("b");
    expect(sess.free(0, { do: "hand", iid: "a" }).ok).toBe(true); // from the discard to MY hand
    expect(M.player(sess.state, 0).hand).toContain("a");
    const deck0 = sess.state.mainDeck.length;
    expect(sess.free(0, { do: "deck", iid: "mine" }).ok).toBe(true); // main-deck card -> main deck
    expect(sess.state.mainDeck.length).toBe(deck0 + 1);
    expect(sess.state.mainDeck).toContain("mine");
  });

  it("a Faith card returns to the FAITH deck; unseen cards (opponent hand) are refused", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("faith", "MJG-014", { value: 1 })); // a Faith-deck card
      p("hand", 1, mk("theirs", "MJG-011"));
    }));
    const f0 = sess.state.faithDeck.length;
    expect(sess.free(0, { do: "deck", iid: "faith" }).ok).toBe(true);
    expect(sess.state.faithDeck.length).toBe(f0 + 1);
    expect(sess.state.faithDeck).toContain("faith");
    expect(sess.free(0, { do: "hand", iid: "theirs" }).ok).toBe(false); // can't see their hand
    expect(M.player(sess.state, 1).hand).toContain("theirs");
  });
});

describe("Free mode: deck draw + search", () => {
  it("draw takes the top of either deck to your hand", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, fa: mk("fa", "MJG-014", { value: 1 }) },
      faithDeck: ["fa"],
    });
    const mTop = sess.state.mainDeck[0]!;
    expect(sess.free(0, { do: "draw", deck: "main" }).ok).toBe(true);
    expect(M.player(sess.state, 0).hand).toContain(mTop);
    expect(sess.free(0, { do: "draw", deck: "faith" }).ok).toBe(true);
    expect(M.player(sess.state, 0).hand).toContain("fa");
    expect(sess.free(0, { do: "draw", deck: "faith" }).ok).toBe(false); // now empty
  });

  it("search shows the WHOLE deck to the searcher only; pick -> hand + shuffle; cancellable", () => {
    const sess = new GameSession(setup(() => {}));
    const deck0 = sess.state.mainDeck.length;
    const wanted = sess.state.mainDeck[deck0 - 1]!; // bottom card — only reachable via search
    expect(sess.free(0, { do: "search", deck: "main" }).ok).toBe(true);
    const ch = sess.viewFor(0).choice;
    expect(ch?.options.length).toBe(deck0); // full deck, revealed to the searcher
    expect(ch?.mandatory).toBeFalsy(); // cancellable
    expect(sess.viewFor(1).choice).toBeNull(); // NOT shown to the opponent
    expect(sess.choose(0, { use: true, target: wanted }).ok).toBe(true);
    expect(M.player(sess.state, 0).hand).toContain(wanted);
    expect(sess.state.mainDeck.length).toBe(deck0 - 1);
    // cancel path: deck untouched
    sess.free(0, { do: "search", deck: "main" });
    expect(sess.choose(0, { use: false }).ok).toBe(true);
    expect(sess.state.mainDeck.length).toBe(deck0 - 1);
    expect(sess.viewFor(0).choice).toBeNull();
  });
});

describe("mandatory replacements beat Mana Extraction (LIVE! is not skippable)", () => {
  it("Chocolate battle-discarding a Spinzaku gets NO attach prompt — LIVE! fires", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("choc", "MJG-C25", { atk: 9, def: 9, value: 3 })); // wins the battle
      p("board", 1, mk("spin", "MJG-C21", { atk: 2, def: 2, value: 5 })); // the loser (LIVE!)
      p("board", 1, mk("other", "", { atk: 1, def: 1 })); // LIVE! host candidate
    }));
    sess.command(0, { do: "attack", attacker: "choc", target: "spin" });
    expect(sess.viewFor(0).choice).toBeNull(); // Mana Extraction NOT offered — LIVE! is mandatory
    // the OWNER (seat 1) picks the host instead (other + choc are candidates)
    expect(sess.viewFor(1).choice?.effectId).toBe("MJG-C21:bottom");
    sess.choose(1, { use: true, target: "other" });
    expect(sess.state.discard).not.toContain("spin");
    expect(sess.state.instances["choc"]?.overlays ?? []).not.toContain("spin"); // not attached to Chocolate
    expect(sess.state.instances["spin"]?.overlays).toContain("other"); // LIVE!: Spinzaku covers a character
  });

  it("a plain loser still gets the optional Mana Extraction prompt", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("choc", "MJG-C25", { atk: 9, def: 9, value: 3 }));
      p("board", 1, mk("prey", "", { atk: 1, def: 1 }));
    }));
    sess.command(0, { do: "attack", attacker: "choc", target: "prey" });
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-C25:bottom"); // still prompts for normal losers
    sess.choose(0, { use: true });
    expect(sess.state.instances["choc"]?.overlays).toContain("prey");
  });
});

describe("LIVE! covers ALL discard destinations (RAWN) and saved losers don't count as battle-discards", () => {
  it("RAWN placing a Spinzaku on the discard BOTTOM is redirected by LIVE!", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("josp", "MJG-M06", { atk: 1, def: 1, value: 4 }));
      p("board", 1, mk("spin", "MJG-C21", { atk: 9, def: 7, value: 5 }));
      p("board", 1, mk("other", "", { atk: 1, def: 1 }));
    }));
    sess.command(0, { do: "activate", iid: "josp", role: "top", targets: ["spin"] });
    expect(sess.state.discard).not.toContain("spin"); // NOT placed on the pile bottom
    expect(sess.state.instances["spin"]?.overlays).toContain("other"); // LIVE!: covers a character instead
    expect(sess.state.discard).toContain("josp"); // RAWN's own discard cost still paid
  });

  it("Terminator does NOT fire when the battle loser was saved by LIVE!", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("steve", "MJG-037", { atk: 5, def: 5, value: 5 }));
      p("board", 1, mk("spin", "MJG-C21", { atk: 2, def: 2, value: 5 }));
      p("board", 1, mk("other", "", { atk: 1, def: 1 }));
    }));
    sess.command(0, { do: "attack", attacker: "steve", target: "spin" });
    expect(sess.viewFor(1).choice?.effectId).toBe("MJG-C21:bottom"); // owner picks the host
    sess.choose(1, { use: true, target: "other" });
    expect(sess.state.instances["spin"]?.overlays).toContain("other"); // saved by LIVE! (covers a character)
    expect(M.atkOf(sess.state, "steve")).toBe(5); // Terminator (-2 ATK / +2 DEF) did NOT trigger
    expect(M.defOf(sess.state, "steve")).toBe(5);
    expect(sess.state.battleDiscardedThisTurn).toBe(false); // nothing actually hit the pile
  });
});

describe("Class Card 'also' clause: the attach fizzles if the revealed card left the hand", () => {
  it("copying >dama and melding the SUBJECT itself: the meld resolves, the attach fizzles silently", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("straw", "MJG-C23", { atk: 1, def: 1, value: 3 }));
      p("hand", 0, mk("hag2", "MJG-002", { value: 2 })); // subject: its bottom Active is >dama (hand meld)
      p("hand", 0, mk("v2a", "", { value: 2 }));
      p("hand", 0, mk("v2b", "", { value: 2 }));
    }));
    sess.command(0, { do: "activate", iid: "straw", role: "bottom" }); // Class Card
    sess.choose(0, { use: true, target: "hag2" }); // reveal the subject
    expect(sess.viewFor(0).choice?.handMeld).toBe(true); // the copied >dama asks for 3 hand cards
    sess.choose(0, { use: true, materials: ["hag2", "v2a", "v2b"] }); // meld INCLUDES the subject
    // the copied effect resolved: the meld was formed (with the subject as a material)
    const mz = M.player(sess.state, 0).meldZone;
    expect(mz.length).toBe(1);
    expect(mz[0]!.cards).toContain("hag2");
    // the "also, attach it" clause fizzled — no overlay, no re-prompt
    expect(sess.state.instances["straw"]?.overlays ?? []).not.toContain("hag2");
    expect(sess.viewFor(0).choice).toBeNull();
    expect(sess.state.log.some((l) => l.includes("the attach fizzles"))).toBe(true);
  });

  it("normal copy (subject stays in hand): still attached after the copy resolves", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("straw", "MJG-C23", { atk: 1, def: 1, value: 3 }));
      p("hand", 0, mk("chotto", "MJG-003", { value: 2 })); // bottom Active: draw the deck bottom
    }));
    sess.command(0, { do: "activate", iid: "straw", role: "bottom" });
    sess.choose(0, { use: true, target: "chotto" });
    expect(sess.state.instances["straw"]?.overlays).toContain("chotto"); // attached after resolution
    expect(M.player(sess.state, 0).hand).not.toContain("chotto");
  });
});

describe("Solem (MJG-C34) vs a SUMMON: negate + destroy, prompting on auto", () => {
  it("an opponent's vanilla Normal Summon prompts the holder (auto) and can be negated", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("s1", "MJG-011", { atk: 1, def: 1, value: 1 })); // the summon to negate
      p("hand", 1, mk("no", "MJG-C34", { atk: 4, def: 4, value: 4 }));
    }));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, x1: mk("x1", "", { value: 2 }), x2: mk("x2", "", { value: 2 }), x3: mk("x3", "", { value: 2 }) },
      players: sess.state.players.map((p) => (p.pid === 1 ? { ...p, meldZone: [{ cards: ["x1", "x2", "x3"], kind: "triplet" as const, kan: false }] } : p)),
    });
    sess.setToggle(1, "auto");
    sess.command(0, { do: "summon", iid: "s1" });
    expect(sess.awaiting).toBe(1); // prompted on AUTO at the summon announcement
    expect(sess.viewFor(1).legal.some((a) => a.kind === "activate" && a.iid === "no" && a.role === "top")).toBe(true);
    const r = sess.respond(1, { activate: { iid: "no", role: "top" } });
    expect(r.ok).toBe(true);
    sess.choose(1, { use: true, target: "0" }); // pay the cost: discard meld #0
    // the summon is negated and the summoned card destroyed; Solem discards itself
    expect(sess.state.log.some((l) => l.includes("is negated (Solem)"))).toBe(true);
    expect(M.player(sess.state, 0).board).not.toContain("s1");
    expect(sess.state.discard).toContain("s1");
    expect(sess.state.discard).toContain("no");
    expect(M.player(sess.state, 1).meldZone.length).toBe(0); // the meld cost was paid
    expect(sess.state.discard).toEqual(expect.arrayContaining(["x1", "x2", "x3"]));
  });

  it("not offered against your OWN summon or without a meld to pay", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("s1", "MJG-011", { atk: 1, def: 1, value: 1 }));
      p("hand", 1, mk("no", "MJG-C34", { atk: 4, def: 4, value: 4 })); // NO meld -> can't pay
      p("hand", 0, mk("no0", "MJG-C34", { atk: 4, def: 4, value: 4 })); // the summoner's own copy
    }));
    sess.setToggle(1, "auto");
    sess.command(0, { do: "summon", iid: "s1" });
    expect(sess.awaiting).toBeNull(); // seat 1 can't pay; seat 0 is the summoner
    expect(M.player(sess.state, 0).board).toContain("s1"); // summon resolves
  });
});

describe("Knot (MJG-WAN) counts OPPONENTS' boards as cost material", () => {
  it("summons off hand + own board + an opponent's face-up board card", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("wan", "MJG-WAN", { atk: 6, def: 9, value: 1 }));
      p("hand", 0, mk("h1", "", { atk: 2, def: 3 })); // hand piece
      p("board", 0, mk("b1", "", { atk: 2, def: 3 })); // own board piece
      p("board", 1, mk("opp1", "", { atk: 2, def: 3 })); // OPPONENT's board piece
      p("board", 1, mk("oppFd", "", { atk: 9, def: 9, faceDown: true })); // face-down: never offered
    }));
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, hand: ["wan", "h1"] } : p)) });
    // activatable at all only because the opponent's card completes the 6/9 total
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "wan" && a.role === "top")).toBe(true);
    sess.command(0, { do: "activate", iid: "wan", role: "top" });
    const opts = sess.viewFor(0).choice?.options ?? [];
    expect(opts.map((o) => o.iid).sort()).toEqual(["b1", "h1", "opp1"]); // face-down excluded
    expect(opts.find((o) => o.iid === "opp1")?.zone).toBe("board"); // direct-clickable on their board
    sess.choose(0, { use: true, target: "h1" });
    sess.choose(0, { use: true, target: "b1" });
    sess.choose(0, { use: true, target: "opp1" }); // 2+2+2 / 3+3+3 = exactly 6 / 9
    expect(M.player(sess.state, 0).board).toContain("wan"); // Special Summoned
    expect(sess.state.discard).toEqual(expect.arrayContaining(["h1", "b1", "opp1"]));
    expect(M.player(sess.state, 1).board).not.toContain("opp1"); // paid from THEIR board
  });
});

describe("free board positions & pages (MJG-C29 / MSGK-C30 prep)", () => {
  it("summons flow left-to-right and wrap below after 7 — never onto a new page", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`b${i}`, mk(`b${i}`, "", { atk: 1, def: 1 })])) },
    });
    for (let i = 0; i < 8; i++) sess.state = applyIntent(sess.state, { kind: "specialSummon", iid: `b${i}`, controller: 0 }).state;
    const pos = (i: string) => sess.state.instances[i]?.pos;
    expect(pos("b0")).toEqual({ x: 0, y: 0, page: 0 });
    expect(pos("b1")).toEqual({ x: 100, y: 0, page: 0 }); // exactly one card wide apart
    expect(pos("b6")).toEqual({ x: 600, y: 0, page: 0 });
    expect(pos("b7")).toEqual({ x: 0, y: 35, page: 0 }); // 8th: back to the left, ~¼ card lower
    expect(M.player(sess.state, 0).boardPages).toBe(1); // auto-placement never adds pages
  });

  it("auto-placement lands on the page its owner is VIEWING", () => {
    const sess = new GameSession(setup((p) => {
      for (let i = 0; i < 4; i++) p("board", 0, mk(`f${i}`, "", { atk: 1, def: 1 })); // 4+ cards unlock the "+"
    }));
    expect(sess.board(0, { do: "addPage" }).ok).toBe(true);
    expect(sess.board(0, { do: "view", page: 1 }).ok).toBe(true);
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, nc: mk("nc", "", { atk: 1, def: 1 }) } });
    sess.state = applyIntent(sess.state, { kind: "specialSummon", iid: "nc", controller: 0 }).state;
    expect(sess.state.instances["nc"]?.pos).toEqual({ x: 0, y: 0, page: 1 });
    expect(sess.viewFor(1).players.find((p) => p.pid === 0)?.boardPages).toBe(2); // pages are public
  });

  it("move: own card on your turn, clamped to the board space; pages must exist", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("a", "", { atk: 1, def: 1 }));
        p("board", 1, mk("t", "", { atk: 1, def: 1 }));
      }),
    );
    expect(sess.viewFor(0).arrange).toBe(true);
    expect(sess.viewFor(1).arrange).toBe(false); // not their turn
    expect(sess.board(0, { do: "move", iid: "a", x: 300, y: 40, page: 0 }).ok).toBe(true);
    expect(sess.state.instances["a"]?.pos).toEqual({ x: 300, y: 40, page: 0 });
    // everyone sees the arrangement (positions are table-public)
    expect(sess.viewFor(1).players.find((p) => p.pid === 0)?.board.find((c) => c.iid === "a")?.pos).toEqual({ x: 300, y: 40, page: 0 });
    expect(sess.board(0, { do: "move", iid: "a", x: 9999, y: -50, page: 0 }).ok).toBe(true);
    expect(sess.state.instances["a"]?.pos).toEqual({ x: 660, y: 0, page: 0 }); // clamped (border)
    expect(sess.board(0, { do: "move", iid: "a", x: 0, y: 0, page: 1 }).ok).toBe(false); // no such page
    expect(sess.board(0, { do: "move", iid: "t", x: 0, y: 0, page: 0 }).ok).toBe(false); // not your card
    expect(sess.board(1, { do: "move", iid: "t", x: 0, y: 0, page: 0 }).ok).toBe(false); // off-turn
  });

  it("arranging is frozen while pending; a new page needs 4+ cards on EVERY page", () => {
    const sess = new GameSession(setup((p) => {
      for (let i = 0; i < 3; i++) p("board", 0, mk(`c${i}`, "", { atk: 1, def: 1 }));
    }));
    sess.state = M.replace(sess.state, { announcedSummon: { iid: "c0", player: 0 } });
    expect(sess.viewFor(0).arrange).toBe(false);
    expect(sess.board(0, { do: "move", iid: "c0", x: 100, y: 0, page: 0 }).ok).toBe(false);
    sess.state = M.replace(sess.state, { announcedSummon: null });
    expect(sess.board(0, { do: "move", iid: "c0", x: 100, y: 0, page: 0 }).ok).toBe(true);
    expect(sess.board(0, { do: "addPage" }).ok).toBe(false); // only 3 cards on page 1
    sess.state = M.replace(sess.state, { // a 4th card unlocks the "+"
      instances: { ...sess.state.instances, c3: mk("c3", "", { atk: 1, def: 1 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, board: [...p.board, "c3"] } : p)),
    });
    expect(sess.board(0, { do: "addPage" }).ok).toBe(true);
    expect(sess.board(0, { do: "addPage" }).ok).toBe(false); // the fresh page 2 is empty
    // the page cap stands regardless of card counts
    sess.state = M.replace(sess.state, { players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, boardPages: 9 } : p)) });
    expect(sess.board(0, { do: "addPage" }).ok).toBe(false);
  });

  it("leaving play clears the position (a re-summon gets a fresh flow slot)", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("a", "", { atk: 1, def: 1 }))));
    expect(sess.board(0, { do: "move", iid: "a", x: 200, y: 100, page: 0 }).ok).toBe(true);
    sess.state = applyIntent(sess.state, { kind: "discard", iid: "a" }).state;
    expect(sess.state.instances["a"]?.pos).toBeUndefined();
  });
});

describe("MTG-001 Counterspell", () => {
  it("counters an activated SPELL: the effect is negated, both cards hit the discard", () => {
    const sess = new GameSession(
      setup((p) => {
        p("hand", 0, mk("han", "MJG-C32", { atk: 2, def: 2, value: 3 })); // Hanana LTG — a SPELL
        p("hand", 1, mk("cs", "MTG-001", { atk: 2, def: 2, value: 2 }));
        p("board", 1, mk("bd", "", { atk: 1, def: 1 })); // LTG's would-be board discard
      }),
    );
    sess.setToggle(1, "auto");
    sess.command(0, { do: "activate", iid: "han", role: "top", targets: ["1"] });
    expect(sess.awaiting).toBe(1); // Counterspell is offered against the SPELL
    expect(sess.respond(1, { activate: { iid: "cs", role: "top" } }).ok).toBe(true);
    expect(sess.state.log.some((l) => l.includes("negated"))).toBe(true);
    expect(M.player(sess.state, 0).board).not.toContain("han"); // the countered SS never happened
    expect(M.player(sess.state, 1).board).toContain("bd"); // and no board discard either
    expect(sess.state.discard).toEqual(expect.arrayContaining(["cs", "han"])); // both disposed
  });

  it("cannot chain to a non-SPELL activation (an Active)", () => {
    const sess = new GameSession(
      setup((p) => {
        p("board", 0, mk("fb", "MJG-M19", { atk: 3, def: 1, value: 5 }));
        p("hand", 1, mk("cs", "MTG-001", { atk: 2, def: 2, value: 2 }));
      }),
    );
    sess.setToggle(1, "always");
    sess.command(0, { do: "activate", iid: "fb", role: "bottom", targets: ["1"] });
    // an ACTIVE on the chain: Counterspell is no legal response, so seat 1 is never awaited
    expect(sess.awaiting).not.toBe(1);
  });
});

describe("MOON-001 Mooncakes", () => {
  it("top 'Emote Spam': the card jumps to the target's hand, you draw 1, the cast is tracked", () => {
    const sess = new GameSession(setup((p) => p("hand", 0, mk("moon", "MOON-001", { atk: 1, def: 1, value: 1 }))));
    const h0 = M.player(sess.state, 0).hand.length;
    const h1 = M.player(sess.state, 1).hand.length;
    sess.command(0, { do: "activate", iid: "moon", role: "top", targets: ["1"] });
    expect(M.player(sess.state, 1).hand).toContain("moon"); // gifted to the opponent
    expect(M.player(sess.state, 0).hand).not.toContain("moon");
    expect(M.player(sess.state, 0).hand.length).toBe(h0); // -moon, +1 drawn
    expect(M.player(sess.state, 1).hand.length).toBe(h1 + 1);
    expect(M.player(sess.state, 0).counters["Mooncake"]).toBe(1); // the cast is public state
  });

  it("bottom 'Soulless' (once per game): everyone without a Mooncake counter skips a turn", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("moon", "MOON-001", { atk: 1, def: 1, value: 1 }))));
    sess.state = M.replace(sess.state, { // seat 0 has cast Emote Spam before; seat 1 never did
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, counters: { ...p.counters, Mooncake: 1 } } : p)),
    });
    sess.command(0, { do: "activate", iid: "moon", role: "bottom" });
    expect(sess.state.pendingSkips).toContain(1); // never cast -> skips their next turn
    expect(sess.state.pendingSkips).not.toContain(0); // the muncher is safe
    // once per game: never offered again (even untapped)
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, moon: { ...sess.state.instances["moon"]!, tapped: false } } });
    expect(sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "moon" && a.role === "bottom")).toBe(false);
  });
});

describe("MJG-M20 FENG — Ya Boy", () => {
  it("bottom '>reading': negates cards with >4 lines from anywhere; ≤4-line cards are immune", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("yaboy", "MJG-M20", { atk: 1, def: 3, value: 4 }));
      p("board", 1, mk("big", "MJG-C29", { atk: 8, def: 1, value: 6, tribes: ["Hag"] })); // DealinDemon (>4 lines)
      p("board", 1, mk("small", "MJG-C28", { atk: 1, def: 4, value: 5, tribes: ["Cunny"] })); // Ojisan (≤4, whitelisted)
    }));
    expect(M.isEffectNegated(sess.state, "big")).toBe(true); // >4 lines -> negated
    expect(M.isEffectNegated(sess.state, "small")).toBe(false); // whitelisted -> immune
    expect(M.isEffectNegated(sess.state, "yaboy")).toBe(false); // exactly 4 -> never negates itself
    // a face-down Ya Boy stops negating
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, yaboy: { ...sess.state.instances["yaboy"]!, faceDown: true } } });
    expect(M.isEffectNegated(sess.state, "big")).toBe(false);
  });

  it("bottom '>reading': a >4-line card can't be activated even from the HAND (from anywhere)", () => {
    const sess = new GameSession(setup((p) => {
      p("hand", 0, mk("hanana", "MJG-C32", { atk: 2, def: 2, value: 3 })); // LTG (SPELL, >4 lines)
      p("board", 1, mk("dummy", "", { atk: 1, def: 1 })); // an opponent board card (LTG's requirement)
      p("board", 1, mk("yaboy", "MJG-M20", { atk: 1, def: 3, value: 4 })); // opponent's Ya Boy
    }));
    const offered = () => sess.viewFor(0).legal.some((a) => a.kind === "activate" && a.iid === "hanana");
    expect(offered()).toBe(false); // negated in hand by the opponent's Ya Boy
    // disable Ya Boy (face-down) -> Hanana is activatable again
    sess.state = M.replace(sess.state, { instances: { ...sess.state.instances, yaboy: { ...sess.state.instances["yaboy"]!, faceDown: true } } });
    expect(offered()).toBe(true);
  });

  it("bottom '>reading': negates Antipsychotics itself, so its [Schizo] negation lifts", () => {
    const sess = new GameSession(setup((p) => {
      p("board", 0, mk("nurse", "MJG-035", { atk: 2, def: 2, value: 5, tribes: ["Hag"] })); // Take your meds (>4 lines)
      p("board", 1, mk("sz", "MJG-C28", { atk: 1, def: 1, value: 5, tribes: ["Schizo"] })); // a ≤4 [Schizo] card
    }));
    expect(M.isEffectNegated(sess.state, "sz")).toBe(true); // Antipsychotics negates the [Schizo]
    // add a Ya Boy -> it negates Antipsychotics (>4 lines) -> the [Schizo] is freed
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, yaboy: mk("yaboy", "MJG-M20", { atk: 1, def: 3, value: 4 }) },
      players: sess.state.players.map((p) => (p.pid === 0 ? { ...p, board: [...p.board, "yaboy"] } : p)),
    });
    expect(M.isEffectNegated(sess.state, "nurse")).toBe(true); // Antipsychotics itself negated
    expect(M.isEffectNegated(sess.state, "sz")).toBe(false); // no longer negated
  });

  it("top 'Fortune Teller': look at the deck top before drawing; can send it to the bottom", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("yaboy", "MJG-M20", { atk: 1, def: 3, value: 4 }))));
    // cycle back to seat 0's draw phase
    sess.command(0, { do: "endTurn" }); sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" });
    sess.command(1, { do: "endTurn" }); sess.command(1, { do: "advance" });
    // pin a known top card
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, topc: mk("topc", "", { value: 7 }), nextc: mk("nextc", "", { value: 2 }) },
      mainDeck: ["topc", "nextc", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "draw" }); // Fortune Teller fires BEFORE the draw
    expect(sess.viewFor(0).choice?.effectId).toBe("MJG-M20:top");
    sess.choose(0, { use: true }); // place it on the bottom
    expect(M.player(sess.state, 0).hand).toContain("nextc"); // drew the NEXT card, not topc
    expect(M.player(sess.state, 0).hand).not.toContain("topc");
    expect(sess.state.mainDeck[sess.state.mainDeck.length - 1]).toBe("topc"); // topc is now on the bottom
  });

  it("top 'Fortune Teller': keeping the top card draws it normally", () => {
    const sess = new GameSession(setup((p) => p("board", 0, mk("yaboy", "MJG-M20", { atk: 1, def: 3, value: 4 }))));
    sess.command(0, { do: "endTurn" }); sess.command(0, { do: "advance" });
    sess.command(1, { do: "draw" });
    sess.command(1, { do: "endTurn" }); sess.command(1, { do: "advance" });
    sess.state = M.replace(sess.state, {
      instances: { ...sess.state.instances, topc: mk("topc", "", { value: 7 }) },
      mainDeck: ["topc", ...sess.state.mainDeck],
    });
    sess.command(0, { do: "draw" });
    sess.choose(0, { use: false }); // keep it
    expect(M.player(sess.state, 0).hand).toContain("topc"); // drew the top card
  });
});

describe("deck-out via a card EFFECT (RULES sec 11)", () => {
  it("drawing from an empty MAIN deck by an effect eliminates the player (and ends a 2p game)", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, { mainDeck: [] }); // empty the Main deck
    const before = M.player(sess.state, 0).eliminated;
    expect(before).toBe(false);
    sess.state = applyIntent(sess.state, { kind: "draw", player: 0, count: 1 }).state;
    expect(M.player(sess.state, 0).eliminated).toBe(true); // ghost board
    expect(M.player(sess.state, 0).board).toEqual([]);
    expect(sess.state.winner).toBe(1); // the other player wins (last standing)
  });

  it("an empty FAITH deck is NOT a deck-out — the effect just draws fewer", () => {
    const sess = new GameSession(setup(() => {}));
    sess.state = M.replace(sess.state, { faithDeck: [] });
    sess.state = applyIntent(sess.state, { kind: "draw", player: 0, count: 1, deck: "faith" }).state;
    expect(M.player(sess.state, 0).eliminated).toBe(false); // not eliminated
    expect(sess.state.winner).toBeNull();
  });
});

