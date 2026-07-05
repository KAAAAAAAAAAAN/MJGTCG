"""MJGTCG card -> image manifest builder + validator."""
import hashlib, json, os, sys
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parent
BASE = ROOT / "base_set.json"
XLSX = ROOT / "MJGTCG.xlsx"
IMG_ROOT = ROOT / "images"
OUT = ROOT / "manifest.json"

# 007/017/Z01 are now real cards in base_set.json. 016a = alt-art of 016;
# X03 = special/joke card with no base_set entry by design; back-* = deck backs
# (used by the client for hidden/face-down cards, not pointed at by any card).
KNOWN_ORPHANS = {"016a", "X03", "back-main", "back-faith"}
BASE_DECKS = ("Main", "Faith", "Base")
DECK_PRIORITY = {"Main": 0, "Faith": 1, "Base": 2}


def load_number_map(card_ids):
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    num = {}
    for row in wb["Base Set"].iter_rows(values_only=True):
        if len(row) > 2 and isinstance(row[2], str):
            cid = row[2].strip()
            if cid in card_ids and row[1] is not None:
                num[cid] = str(row[1]).strip()
    return num


def index_images():
    idx = {}
    for root, _dirs, files in os.walk(IMG_ROOT):
        deck = os.path.basename(root)
        for f in files:
            if f.lower().endswith(".png"):
                rel = os.path.relpath(os.path.join(root, f), ROOT).replace("\\", "/")
                idx.setdefault(f[:-4], []).append((deck, rel))
    return idx


def code_for(card_id, number):
    if number is None:
        return card_id.split("-")[-1]
    return number.zfill(3) if str(number).isdigit() else str(number)


def file_hash(path):
    return hashlib.md5((ROOT / path).read_bytes()).hexdigest()[:12]


def build():
    cards = json.loads(BASE.read_text(encoding="utf-8"))
    card_ids = {c["id"] for c in cards}
    num_map = load_number_map(card_ids)
    images = index_images()
    manifest, gaps, used = {}, [], set()
    for c in cards:
        cid = c["id"]
        code = c.get("_image_code") or code_for(cid, num_map.get(cid))
        hits = [h for h in images.get(code, []) if h[0] in BASE_DECKS]
        if not hits:
            gaps.append((cid, code))
            continue
        deck, path = sorted(hits, key=lambda h: DECK_PRIORITY.get(h[0], 9))[0]
        manifest[cid] = {"number": code, "name": c.get("name", ""),
                         "image": path, "deck": deck, "hash": file_hash(path)}
        used.add(code)
    base_codes = {code for code, hits in images.items()
                  if any(d in BASE_DECKS for d, _ in hits)}
    orphans = sorted(base_codes - used - KNOWN_ORPHANS)
    return cards, manifest, gaps, orphans


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    cards, manifest, gaps, orphans = build()
    OUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    by_deck = {}
    for v in manifest.values():
        by_deck[v["deck"]] = by_deck.get(v["deck"], 0) + 1
    print(f"manifest: {len(manifest)}/{len(cards)} cards -> {OUT.name}")
    print("  by deck: " + ", ".join(f"{k}={v}" for k, v in sorted(by_deck.items())))
    ok = True
    if gaps:
        ok = False
        print(f"  MISSING ART ({len(gaps)}):")
        for cid, code in gaps:
            print(f"    {cid} -> expected {code}.png  NOT FOUND")
    if orphans:
        ok = False
        print(f"  UNEXPECTED ORPHAN IMAGES ({len(orphans)}):")
        for code in orphans:
            print(f"    {code}.png  (no card points at it)")
    if ok:
        print("  OK: every card has art, no unexpected orphans.")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
