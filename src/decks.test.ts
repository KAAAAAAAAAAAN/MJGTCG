import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDecks, mainCopies, type ManifestEntry } from "./decks.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(here, "../manifest.json"), "utf-8"),
) as Record<string, ManifestEntry>;

describe("buildDecks (manifest deck field)", () => {
  const { main, faith } = buildDecks(manifest); // default: 2-player

  // 86 Main + 28 Faith currently playable (Mooncakes, Catbox + Counterspell included). Faith
  // grows to 28 once Mooncakes (MJG-Z01) gets a real id in the sheet (its id cell is
  // "-" pending re-add); the 4 art-less new cards (MJG-CBA/GAR/RIN/USED) join their
  // decks once art is added.
  it("splits into 86 Main + 28 Faith (one copy each)", () => {
    expect(faith.length).toBe(28);
    expect(main.length).toBe(86);
  });

  it("excludes non-playable 'Base' entries and the opt-in League expansion", () => {
    const league = Object.values(manifest).filter((e) => e.deck === "League").length;
    expect(league).toBe(72);
    expect(main.length + faith.length).toBe(Object.keys(manifest).length - 1 - league); // 1 'Base' + 72 League excluded by default
  });

  it("the League expansion (opt-in) adds its 72 cards to Main, one copy each", () => {
    const base = buildDecks(manifest, 2).main.length;
    const withLeague = buildDecks(manifest, 2, { league: true });
    expect(withLeague.main.length).toBe(base + 72); // +72 League cards
    expect(withLeague.main).toContain("MJG-L01");
    const c = withLeague.main.filter((id) => id.startsWith("MJG-L"));
    expect(c.length).toBe(72);
    expect(new Set(c).size).toBe(72); // one copy each
    expect(withLeague.faith.length).toBe(faith.length); // Faith unchanged
    // even in a 3+ player game, League cards stay at ONE copy each
    const multi = buildDecks(manifest, 4, { league: true });
    expect(multi.main.filter((id) => id === "MJG-L01").length).toBe(1);
  });

  it("includes the Faith-deck cards that are NOT ability-type F", () => {
    for (const id of ["MJG-040", "MJG-C26", "NYA-001", "SHA-001"]) expect(faith).toContain(id);
  });

  it("main and faith are disjoint", () => {
    const set = new Set(main);
    expect(faith.some((id) => set.has(id))).toBe(false);
  });

  it("2-player: exactly one copy of every card", () => {
    const counts = main.reduce((m, id) => (m.set(id, (m.get(id) ?? 0) + 1), m), new Map<string, number>());
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it("3+ players: 2 of each Main card, Brick/Mooncakes stay 1, LOB-001 is 3; Faith stays 1", () => {
    const big = buildDecks(manifest, 3);
    const c = big.main.reduce((m, id) => (m.set(id, (m.get(id) ?? 0) + 1), m), new Map<string, number>());
    expect(c.get("LOB-001")).toBe(3);
    expect(c.get("MJG-C16")).toBe(1); // The Brick
    expect(c.get("MOON-001")).toBe(1); // Mooncakes
    expect(c.get("MJG-001")).toBe(2); // an ordinary Main card
    // 86 distinct Main cards: 83 ordinary ×2 + Brick 1 + Mooncakes 1 + LOB 3 = 171
    expect(big.main.length).toBe(171);
    expect(big.faith.length).toBe(faith.length); // Faith unchanged (one each)
    const fc = big.faith.reduce((m, id) => (m.set(id, (m.get(id) ?? 0) + 1), m), new Map<string, number>());
    expect([...fc.values()].every((n) => n === 1)).toBe(true);
  });

  it("mainCopies encodes the per-count multiplicities", () => {
    expect(mainCopies("MJG-001", 2)).toBe(1);
    expect(mainCopies("LOB-001", 2)).toBe(1); // 2p: everything is 1
    expect(mainCopies("MJG-001", 4)).toBe(2);
    expect(mainCopies("LOB-001", 4)).toBe(3);
    expect(mainCopies("MJG-C16", 4)).toBe(1);
    expect(mainCopies("MOON-001", 4)).toBe(1);
  });
});
