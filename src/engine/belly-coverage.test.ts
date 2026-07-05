import { describe, it, expect } from "vitest";
import { ACTIVATIONS, RESOLVE_CHOICES } from "./legal.js";
import { getScript } from "./card-scripts.js";

/**
 * Guard: Belly Dance (MJG-015) copies ANY of a character's Active abilities by
 * gathering their input and resolving them through the normal pipeline. For that to
 * work, every board Active must be reachable by that pipeline. This test fails if a
 * future Active is added that Belly Dance can't currently copy — so it can't be
 * silently left out: either give it a script, or extend Belly Dance to cover it.
 */
describe("Belly Dance copies every Active", () => {
  // activation-target kinds the Belly Dance resolution gathers (session.maybePromptResolveChoice)
  const GATHERABLE = new Set(["character", "opponent", "discard"]);

  it("every board Active is copyable (runnable script + a supported target kind)", () => {
    for (const [eid, spec] of Object.entries(ACTIVATIONS)) {
      if (spec.category !== "A" || spec.from !== "board") continue; // only board Actives are copyable
      if (spec.handMeld) continue; // handled specially (meld-from-hand pick)
      if (RESOLVE_CHOICES[eid]?.bellyDance || RESOLVE_CHOICES[eid]?.classCard) continue; // session-resolved copies (Belly Dance / Class Card)
      const [cardId, role] = eid.split(":") as [string, string];

      // the link is transformed into this Active, so it must have a runnable script
      expect(getScript(cardId, role), `${eid}: no script — Belly Dance would silently no-op it`).toBeTruthy();

      // and any activation-targets it needs must be gatherable by Belly Dance
      if ((spec.targets ?? 0) > 0) {
        expect(
          GATHERABLE.has(spec.targetKind ?? ""),
          `${eid}: targetKind '${spec.targetKind}' isn't gathered by Belly Dance — extend session.maybePromptResolveChoice`,
        ).toBe(true);
      }
    }
  });
});
