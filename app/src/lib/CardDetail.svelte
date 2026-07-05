<script lang="ts">
  import type { CardView } from "@net/session.js";
  import baseSet from "@root/base_set.json";
  import manifest from "@root/manifest.json";

  export let card: CardView | null = null;

  type Ability = { role?: string; type?: string; title?: string; text?: string };
  type Rec = {
    id: string; name: string; atk: number; def: number; value: number | null;
    tribes?: string[]; abilities: Ability[]; flavor?: string;
  };
  const REC = new Map((baseSet as Rec[]).map((c) => [c.id, c]));
  const MAN = manifest as Record<string, { image?: string }>;
  const TYPE: Record<string, string> = { S: "Spell", A: "Active", P: "Passive", F: "Faith", B: "Brick" };
  const V = (n: number | null | undefined) => (n === null || n === undefined ? "☆" : String(n));

  $: rec = card?.cardId ? (REC.get(card.cardId) ?? null) : null;
  $: img = card?.cardId && MAN[card.cardId]?.image ? `/${MAN[card.cardId]!.image}` : undefined;
</script>

{#if rec}
  <aside class="detail">
    {#if img}<img class="big" src={img} alt={rec.name} />{/if}
    <div class="body">
      <div class="name">{rec.name}</div>
      <div class="stats">
        <span class="atk">ATK {card?.atk ?? rec.atk}</span>
        <span class="def">DEF {card?.def ?? rec.def}</span>
        <span class="val">VAL {V(card?.value ?? rec.value)}</span>
        {#if rec.tribes && rec.tribes.length}<span class="tribes">{rec.tribes.join(" / ")}</span>{/if}
      </div>
      {#each rec.abilities as a}
        {#if (a.text ?? "").trim()}
          <div class="ability">
            <span class="badge b-{a.type ?? '-'}">{TYPE[a.type ?? ''] ?? a.type}</span>
            {#if a.title}<span class="atitle">{a.title}</span>{/if}
            <div class="atext">{a.text}</div>
          </div>
        {/if}
      {/each}
      {#if rec.flavor}<div class="flavor">{rec.flavor}</div>{/if}
    </div>
  </aside>
{/if}

<style>
  .detail {
    position: fixed; top: 12px; right: 12px; width: 280px; z-index: 70; /* above the pile-viewer backdrop (60) */
    pointer-events: none; /* never block board interaction */
    background: #12161dF2; border: 1px solid #2f3947; border-radius: 12px;
    box-shadow: 0 8px 28px #000a; overflow: hidden;
    display: flex; flex-direction: column;
  }
  .big { width: 100%; display: block; max-height: 320px; object-fit: contain; background: #0c0f14; }
  .body { padding: 10px 12px 12px; }
  .name { font-weight: 700; font-size: 14px; color: #eaeef4; margin-bottom: 4px; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; margin-bottom: 8px; }
  .stats .atk { color: #ff9b9b; }
  .stats .def { color: #9bd0ff; }
  .stats .val { color: #ffe08a; }
  .stats .tribes { color: #b69bff; }
  .ability { margin: 6px 0; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #2a313c; color: #cdd4de; margin-right: 5px; }
  .b-S { background: #1e3148; color: #bfe3ff; }
  .b-A { background: #1e3a2a; color: #cffbe0; }
  .b-P { background: #2a2333; color: #e7ddff; }
  .b-F { background: #3a331e; color: #ffe08a; }
  .b-B { background: #3a1f24; color: #ffb4bd; }
  .atitle { font-weight: 600; color: #cdd4de; font-size: 12px; }
  .atext { color: #aeb6c2; font-size: 12px; line-height: 1.35; margin-top: 2px; }
  .flavor { color: #69707c; font-style: italic; font-size: 11px; margin-top: 8px; }
</style>
