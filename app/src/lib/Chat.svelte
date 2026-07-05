<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { ChatMsg } from "./menu/types.js";

  export let messages: ChatMsg[] = [];
  export let mySeat: number | null = null;

  const dispatch = createEventDispatcher<{ send: string; bug: string }>();
  const REPO = "https://github.com/KAAAAAAAAAAAN/MJGTCG";
  let minimized = false;
  let showLog = false; // full chat-log popup
  let showBug = false; // bug-report popup
  let draft = "";
  let bugDraft = "";
  let listEl: HTMLDivElement | null = null;

  function sendBug() {
    const t = bugDraft.trim();
    if (!t) return;
    dispatch("bug", t);
    bugDraft = "";
    showBug = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (showLog) showLog = false;
    else if (showBug) showBug = false;
  }

  const SPECTATOR = -1;
  // prefer the sender's nickname (stamped on the message); fall back to a seat label
  const who = (m: ChatMsg) => m.name || (m.seat === SPECTATOR ? "Spectator" : `P${m.seat}`);
  // stable per-seat colour so senders are easy to tell apart
  const COLORS = ["#6ea8ff", "#ff9b9b", "#9be7a0", "#ffcf6e", "#c9a2ff", "#7fe0d6"];
  const colorOf = (seat: number) => (seat === SPECTATOR ? "#8b95a3" : COLORS[((seat % COLORS.length) + COLORS.length) % COLORS.length]);

  $: newest2 = messages.slice(-2);

  function send() {
    const t = draft.trim();
    if (!t) return;
    dispatch("send", t);
    draft = "";
  }

  // keep the expanded list pinned to the newest message. Reactive on messages
  // (not afterUpdate+tick, which floods the scheduler and freezes the page); the
  // rAF only reads/writes the DOM, never Svelte state, so it can't loop.
  $: if (listEl && !minimized && messages.length) {
    const el = listEl;
    requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  }
</script>

<div class="chat" class:min={minimized}>
  <div class="head">
    <b>Chat</b>
    <span class="count">{messages.length}</span>
    <a class="ic gh" href={REPO} target="_blank" rel="noreferrer" title="source code on GitHub">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
    </a>
    <button class="ic" title="report a bug" on:click={() => (showBug = true)}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
    </button>
    <span class="grow"></span>
    <button class="ic" title="full chat log" on:click={() => (showLog = true)}>⤢</button>
    <button class="ic" title={minimized ? "expand" : "minimize"} on:click={() => (minimized = !minimized)}>{minimized ? "▢" : "—"}</button>
  </div>

  {#if minimized}
    <!-- minimized: only the 2 newest messages -->
    <div class="peek">
      {#each newest2 as m}
        <div class="msg"><span class="nm" style="color:{colorOf(m.seat)}">{who(m)}:</span> <span class="tx">{m.text}</span></div>
      {:else}
        <div class="empty">no messages yet</div>
      {/each}
    </div>
  {:else}
    <div class="list" bind:this={listEl}>
      {#each messages as m}
        <div class="msg"><span class="nm" style="color:{colorOf(m.seat)}">{who(m)}:</span> <span class="tx">{m.text}</span></div>
      {:else}
        <div class="empty">no messages yet — say hi</div>
      {/each}
    </div>
  {/if}

  <form class="input" on:submit|preventDefault={send}>
    <input placeholder="message…" maxlength="300" bind:value={draft} />
    <button type="submit" disabled={!draft.trim()}>Send</button>
  </form>
</div>

<svelte:window on:keydown={onKey} />

{#if showLog}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="backdrop" on:click={() => (showLog = false)}>
    <div class="panel" on:click|stopPropagation>
      <div class="phead"><b>Chat log</b><span class="count">{messages.length}</span><button class="x" on:click={() => (showLog = false)}>✕</button></div>
      <div class="plist">
        {#each messages as m}
          <div class="msg"><span class="nm" style="color:{colorOf(m.seat)}">{who(m)}:</span> <span class="tx">{m.text}</span></div>
        {:else}
          <div class="empty">no messages yet</div>
        {/each}
      </div>
    </div>
  </div>
{/if}

{#if showBug}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="backdrop" on:click={() => (showBug = false)}>
    <div class="panel bug" on:click|stopPropagation>
      <div class="phead"><b>Report a bug</b><button class="x" on:click={() => (showBug = false)}>✕</button></div>
      <div class="bwrap">
        <p class="bnote">Describe what went wrong — what you did and what happened. Your name, seat and room code are attached automatically.</p>
        <textarea bind:value={bugDraft} maxlength="1800" rows="5" placeholder="e.g. I played X, chained Y, and the board froze…"></textarea>
        <div class="brow">
          <button type="button" class="bcancel" on:click={() => (showBug = false)}>Cancel</button>
          <button type="button" class="bsend" disabled={!bugDraft.trim()} on:click={sendBug}>Send report</button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .chat {
    position: fixed; right: 14px; bottom: 14px; z-index: 70; width: 300px; max-width: calc(100vw - 28px);
    background: #141923; border: 1px solid #2f3947; border-radius: 12px; box-shadow: 0 10px 34px #000a;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid #232a34; }
  .head b { color: #eaeef4; font-size: 13px; }
  .count { color: #69707c; font-size: 11px; }
  .grow { margin-left: auto; }
  .ic { background: #20252f; color: #cdd4de; border: 1px solid #39414e; border-radius: 6px;
        width: 24px; height: 22px; display: grid; place-items: center; cursor: pointer; font-size: 12px; }
  .ic:hover { background: #2a313d; }
  .gh { text-decoration: none; }
  .ic svg { display: block; }
  .list { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; overflow-y: auto; height: 180px;
          font: 12px/1.35 ui-sans-serif, system-ui, sans-serif; }
  .peek { display: flex; flex-direction: column; gap: 3px; padding: 6px 10px; font: 12px/1.3 ui-sans-serif, system-ui, sans-serif; }
  .msg { color: #c4ccd6; word-break: break-word; }
  .nm { font-weight: 700; }
  .tx { color: #c4ccd6; }
  .empty { color: #69707c; font-size: 12px; }
  .input { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #232a34; }
  .input input { flex: 1; min-width: 0; font: inherit; font-size: 12px; background: #1a212c; color: #eaeef4;
                 border: 1px solid #39414e; border-radius: 7px; padding: 6px 9px; }
  .input input:focus { outline: none; border-color: #6ea8ff; }
  .input button { font: inherit; font-size: 12px; background: #16271d; color: #cffbe0; border: 1px solid #4f7;
                  border-radius: 7px; padding: 6px 12px; cursor: pointer; }
  .input button:disabled { opacity: 0.4; cursor: default; }
  .backdrop { position: fixed; inset: 0; z-index: 80; background: #000a; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .panel { background: #141923; border: 1px solid #2f3947; border-radius: 12px; max-width: 520px; max-height: 80vh; width: 100%;
           display: flex; flex-direction: column; box-shadow: 0 12px 40px #000c; }
  .phead { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #232a34; }
  .phead b { color: #eaeef4; }
  .x { margin-left: auto; background: #232730; color: #d6dae0; border: 1px solid #39414e; border-radius: 6px; padding: 2px 9px; cursor: pointer; }
  .x:hover { background: #2c313c; }
  .plist { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; overflow-y: auto;
           font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }
  .panel.bug { max-width: 440px; }
  .bwrap { display: flex; flex-direction: column; gap: 10px; padding: 14px; }
  .bnote { margin: 0; color: #9aa3b1; font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; }
  .bwrap textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 96px; font: inherit; font-size: 13px;
                    background: #1a212c; color: #eaeef4; border: 1px solid #39414e; border-radius: 8px; padding: 8px 10px; }
  .bwrap textarea:focus { outline: none; border-color: #6ea8ff; }
  .brow { display: flex; justify-content: flex-end; gap: 8px; }
  .bcancel { font: inherit; font-size: 12px; background: #1a212c; color: #cdd4de; border: 1px solid #39414e; border-radius: 7px; padding: 6px 12px; cursor: pointer; }
  .bcancel:hover { background: #222a36; }
  .bsend { font: inherit; font-size: 12px; background: #16271d; color: #cffbe0; border: 1px solid #4f7; border-radius: 7px; padding: 6px 14px; cursor: pointer; }
  .bsend:hover:not(:disabled) { background: #1d3528; }
  .bsend:disabled { opacity: 0.4; cursor: default; }
</style>
