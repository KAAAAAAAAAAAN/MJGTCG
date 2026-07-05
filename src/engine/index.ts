/**
 * MJGTCG engine — public entry point.
 *
 * Layers:
 *  - rules:        pure legality & ordering helpers (the 5 rulings + once-per-X).
 *  - reducer:      the authoritative state machine (Phase x ActionType -> reduce).
 *  - psct:         Problem-Solving Card Text parser (effect text -> tree).
 *  - effects:      effect-execution model (intent interpreter).
 *  - card-scripts: per-card effect scripts.
 *
 * Importing this module wires the effect resolver into the reducer, so chain
 * links with a script reference actually run their card scripts on resolution.
 */
import { setEffectResolver, setTriggerCollector, setAuraProvider, setRestrictionChecker, setBattleDiscardReplacer } from "./reducer.js";
import { resolveChainLink } from "./effects.js";
import { collectTriggers } from "./triggers.js";
import { computeAuras } from "./auras.js";
import { checkRestrictions } from "./restrictions.js";
import { battleDiscardReplacement } from "./replacements.js";

setEffectResolver(resolveChainLink);
setTriggerCollector(collectTriggers);
setAuraProvider(computeAuras);
setRestrictionChecker(checkRestrictions);
setBattleDiscardReplacer(battleDiscardReplacement);

export * as rules from "./rules.js";
export * from "./reducer.js";
export * as psct from "./psct.js";
export * as effects from "./effects.js";
export * as cardScripts from "./card-scripts.js";
export * as triggers from "./triggers.js";
export * as auras from "./auras.js";
export * as restrictions from "./restrictions.js";
export * as replacements from "./replacements.js";
