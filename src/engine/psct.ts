/**
 * MJGTCG PSCT (Problem-Solving Card Text) parser.
 *
 * Ported from the Python reference `psct.py`. Turns the free-text effect strings
 * in base_set.json into a structured tree the rules engine can walk. Grounded in
 * cards/_psct_dump.txt and cards/_faq_dump.txt. Field names are kept snake_case
 * to stay schema-compatible with base_set_parsed.json.
 */

export interface Connector {
  kind: string;
  dependent: boolean;
  can_respond_between: boolean;
}
export interface Step {
  text: string;
  actions: string[];
  optional: boolean;
  targets: boolean;
  instead: boolean;
  continuous: boolean;
  // Present only on real steps (added during step-splitting); choice-menu
  // options omit it entirely, matching the Python reference output.
  connector?: Connector | null;
}
export interface Parsed {
  raw: string;
  clauses: string[];
  flags: Record<string, boolean>;
  activation: string | null;
  choice: boolean;
  options?: Step[];
  steps: Step[];
  step_count: number;
}

const CLAUSE_PAT = /^\s*\(([^)]+)\)\s*/;
const KNOWN_CLAUSES: Record<string, string> = {
  "once per turn": "once_per_turn",
  "once per game": "once_per_game",
  "once per player": "once_per_player",
  mandatory: "mandatory",
  "at any time": "at_any_time",
  repeat: "repeat",
  optional: "optional",
};

interface ConnectorSpec {
  re: RegExp;
  kind: string;
  dependent: boolean;
  canRespond: boolean;
}
// Order matters: ties on match position resolve to the earlier entry.
const CONNECTORS: ConnectorSpec[] = [
  { re: /\s*,?\s*\bif you do\b\s*,?\s*/i, kind: "if_you_do", dependent: true, canRespond: false },
  { re: /\s*,?\s*\biyd\b\s*,?\s*/i, kind: "if_you_do", dependent: true, canRespond: false },
  { re: /\s*,?\s*\band then\b\s*/i, kind: "and", dependent: true, canRespond: false },
  { re: /\s*,?\s*\balso\b\s*,?\s*/i, kind: "also", dependent: false, canRespond: false },
  { re: /\s*;\s*/, kind: "then", dependent: true, canRespond: true },
  { re: /\s*\bthen\b\s*/i, kind: "then", dependent: true, canRespond: true },
  { re: /\s*,?\s*\band\b\s*/i, kind: "and", dependent: true, canRespond: false },
];

const ACTION_KW: [string, RegExp][] = [
  ["special_summon", /\bspecial summon\b/i],
  ["normal_summon", /\bnormal summon\b/i],
  ["summon", /\bsummon\b/i],
  ["draw", /\bdraws?\b/i],
  ["discard", /\bdiscards?\b/i],
  ["search", /\bsearch(es)?\b/i],
  ["reveal", /\breveals?\b/i],
  [
    "add_to_hand",
    /\b(add .*?to .*?hand|return .*?to .*?hand|add .*?cards? .*?to (yours|theirs|their hand))\b/i,
  ],
  ["give", /\bgive (the owner|an opponent|them|your)\b/i],
  ["meld", /\bmelds?\b/i],
  ["kan", /\bKAN\b/],
  ["negate", /\bnegates?\b/i],
  ["destroy", /\bdestroys?\b/i],
  ["banish", /\bbanish(es)?\b/i],
  ["tribute", /\btributes?\b/i],
  ["shuffle", /\bshuffles?\b/i],
  ["place", /\bplaces?\b/i],
  ["flip", /\bflips?\b/i],
  ["gain_control", /\b(gain control|take control|control (their|his|her|its) .*turn)\b/i],
  ["swap", /\bswap (places|control)\b/i],
  ["change_value", /\bVALUE\b/i],
  ["change_stat", /\b(ATK|DEF)\b/],
  ["end_turn", /\bend (your |the )?turn\b/i],
  ["skip_turn", /\bskip .*turn\b/i],
  ["select", /\b(target|choose|select|offer|look at|move)\b/i],
  ["attach", /\b(attach|overlay)\b/i],
  ["stun", /\bstun\b/i],
  ["attack_again", /\battack again\b/i],
  ["attack", /\battacks?\b/i],
  ["fight_back", /\bfight(s)? back\b/i],
  ["add_counter", /\b(add \d|gain(s)? \d+ \w+ counter|counter)\b/i],
  ["repeat", /\brepeat\b/i],
  ["show", /\bshow (your|their|his|her)? ?hand\b/i],
  ["copy_ability", /\buse one of its (ACTIVE|active|PASSIVE|SPELL) abilit/i],
  ["win", /\b(you|they|that player) win(s)? the game\b/i],
  ["lose", /\b(you|they|that player) lose(s)? the game\b/i],
  [
    "immunity",
    /\b(cannot be|is immune|are immune|cannot attack|cannot use|cannot activate|cannot make melds|can(no|'|)t attack)\b/i,
  ],
];
const OPTIONAL_PAT = /\byou can\b/i;
const TARGET_PAT = /\btarget\b/i;
const INSTEAD_PAT = /\binstead\b/i;
const CONTINUOUS_PAT = /\b(cannot|immune|until .*leaves|until the end|while|as long as|persist)\b/i;

const BULLET = "•";

export function extractClauses(text: string): {
  clauses: string[];
  flags: Record<string, boolean>;
  rest: string;
} {
  const clauses: string[] = [];
  const flags: Record<string, boolean> = {};
  for (;;) {
    const m = CLAUSE_PAT.exec(text);
    if (!m) break;
    const raw = m[1]!.trim();
    const key = KNOWN_CLAUSES[raw.toLowerCase()];
    clauses.push(raw);
    if (key) flags[key] = true;
    text = text.slice(m[0].length);
  }
  return { clauses, flags, rest: text.trim() };
}

export function splitActivation(text: string): [string | null, string] {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return [null, text.trim()];
}

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

export function findFullstop(s: string): number | null {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ".") continue;
    const prev = i > 0 ? s[i - 1]! : "";
    const nxt = i + 1 < s.length ? s[i + 1]! : " ";
    if (isDigit(prev) && isDigit(nxt)) continue; // decimal, e.g. 1.5
    if (i + 1 >= s.length || s.slice(i + 1).trim() === "") continue; // trailing
    if (nxt !== " " && nxt !== '"' && nxt !== "“") continue;
    return i;
  }
  return null;
}

function splitSteps(effect: string): [Connector | null, string][] {
  if (!effect) return [];
  const steps: [Connector | null, string][] = [];
  let rest = effect;
  let prevConn: Connector | null = null;
  while (rest) {
    let best:
      | { start: number; end: number; kind: string; dependent: boolean; canRespond: boolean }
      | null = null;
    for (const c of CONNECTORS) {
      const m = c.re.exec(rest);
      if (m && m.index > 0) {
        if (best === null || m.index < best.start) {
          best = {
            start: m.index,
            end: m.index + m[0].length,
            kind: c.kind,
            dependent: c.dependent,
            canRespond: c.canRespond,
          };
        }
      }
    }
    const fs = findFullstop(rest);
    if (fs !== null && (best === null || fs < best.start)) {
      best = { start: fs, end: fs + 1, kind: "next", dependent: false, canRespond: true };
    }
    if (best === null) {
      steps.push([prevConn, rest.trim()]);
      break;
    }
    steps.push([prevConn, rest.slice(0, best.start).trim()]);
    prevConn = { kind: best.kind, dependent: best.dependent, can_respond_between: best.canRespond };
    rest = rest.slice(best.end).trim();
    if (!rest) break;
  }
  return steps.filter(([, t]) => t);
}

export function tagStep(text: string): Step {
  const actions = ACTION_KW.filter(([, pat]) => pat.test(text)).map(([name]) => name);
  return {
    text,
    actions,
    optional: OPTIONAL_PAT.test(text),
    targets: TARGET_PAT.test(text),
    instead: INSTEAD_PAT.test(text),
    continuous: CONTINUOUS_PAT.test(text),
  };
}

function splitChoice(effect: string): string[] | null {
  if (!effect.includes(BULLET)) return null;
  const parts = effect
    .split(BULLET)
    .map((p) => p.replace(/^[ .\n]+|[ .\n]+$/g, ""))
    .filter((p) => p);
  return parts.length > 1 ? parts : null;
}

function mergeVerblessFragments(steps: Step[]): Step[] {
  if (!steps.length) return steps;
  const merged: Step[] = [steps[0]!];
  for (const node of steps.slice(1)) {
    const conn = node.connector ?? null;
    const nonRespondable = conn?.can_respond_between === false;
    if (nonRespondable && node.actions.length === 0 && merged.length) {
      const prev = merged[merged.length - 1]!;
      const combined = (prev.text.replace(/[ ,;.]+$/, "") + ", " + node.text).trim();
      const retag = tagStep(combined);
      retag.connector = prev.connector;
      merged[merged.length - 1] = retag;
    } else {
      merged.push(node);
    }
  }
  return merged;
}

export function parseEffect(text: string): Parsed {
  const { clauses, flags, rest: body } = extractClauses(text);
  const [activation, effect] = splitActivation(body);
  const choice = splitChoice(effect);
  if (choice !== null) {
    const options = choice.map((opt) => tagStep(opt));
    return {
      raw: text,
      clauses,
      flags,
      activation,
      choice: true,
      options,
      steps: [],
      step_count: 0,
    };
  }
  const rawSteps = splitSteps(effect);
  let steps: Step[] = rawSteps.map(([conn, stext]) => {
    const node = tagStep(stext);
    node.connector = conn;
    return node;
  });
  steps = mergeVerblessFragments(steps);
  return {
    raw: text,
    clauses,
    flags,
    activation,
    choice: false,
    steps,
    step_count: steps.length,
  };
}

/** Attach a `parsed` tree to every non-empty ability (mirrors psct.build()). */
export function buildParsed<T extends { abilities: { text?: string; parsed?: Parsed | null }[] }>(
  cards: T[],
): T[] {
  for (const c of cards) {
    for (const a of c.abilities) {
      a.parsed = (a.text ?? "").trim() ? parseEffect(a.text!) : null;
    }
  }
  return cards;
}
