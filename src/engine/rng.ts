/**
 * MJGTCG deterministic PRNG (mulberry32).
 *
 * The engine must be REPLAYABLE: given the same initial state (incl. the
 * pre-shuffled decks) and the same action log, it must reproduce the same game.
 * In-effect randomness (random discard, hand re-deal, …) therefore can't call
 * Math.random — it threads a 32-bit state through `GameState.rngState`. Each
 * helper takes the current state and returns the drawn value plus the NEXT
 * state, which the caller stores back so the stream advances deterministically.
 */

/** One step of mulberry32: a float in [0,1) and the next state. */
export function nextFloat(state: number): { value: number; state: number } {
  let t = (state + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: t >>> 0 };
}

/** A uniform integer in [0, n) and the next state (n must be > 0). */
export function nextInt(state: number, n: number): { value: number; state: number } {
  const r = nextFloat(state);
  return { value: Math.floor(r.value * n), state: r.state };
}

/** A Fisher-Yates shuffled COPY of `arr` plus the next state. */
export function shuffleWith<T>(state: number, arr: readonly T[]): { value: T[]; state: number } {
  const out = [...arr];
  let st = state;
  for (let i = out.length - 1; i > 0; i--) {
    const r = nextInt(st, i + 1);
    st = r.state;
    const j = r.value;
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return { value: out, state: st };
}
