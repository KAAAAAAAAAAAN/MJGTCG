/**
 * Deck composition from the card manifest.
 *
 * Which physical deck a card belongs to is the `deck` field in manifest.json
 * ("Main" / "Faith" / "Base"), derived from the images/Base/{Main,Faith} folders
 * — NOT the ability category. (Ability type "F" only governs normal-summon
 * legality; several Faith-deck cards are type A/S/B.)
 */
export interface ManifestEntry {
  deck?: string;
  [k: string]: unknown;
}

/** Number of copies of a Main-deck card `id` for a game of `players` seats.
 *  2-player: one of everything. 3+ players: two of each Main card, EXCEPT The Brick
 *  (MJG-C16) and Mooncakes (MOON-001) stay at one, and Blue-Eyes White Dragon
 *  (LOB-001) has three. Faith cards are always one each, at any player count. */
export function mainCopies(id: string, players: number): number {
  if (players <= 2) return 1;
  if (id === "LOB-001") return 3;
  if (id === "MJG-C16" || id === "MOON-001") return 1;
  return 2;
}

/** Card ids per playable deck for a `players`-seat game. "Base"/other are excluded.
 *  Faith is one copy each; Main multiplicity scales with the player count (mainCopies). */
export function buildDecks(manifest: Record<string, ManifestEntry>, players = 2, opts: { league?: boolean } = {}): {
  main: string[];
  faith: string[];
} {
  const main: string[] = [];
  const faith: string[] = [];
  for (const [id, e] of Object.entries(manifest)) {
    if (e.deck === "Faith") faith.push(id); // Faith: always one each
    else if (e.deck === "Main") for (let k = 0; k < mainCopies(id, players); k++) main.push(id);
    // "League" expansion (opt-in): its cards are Main-deck cards, one copy each regardless of player count
    else if (e.deck === "League" && opts.league) main.push(id);
  }
  return { main, faith };
}
