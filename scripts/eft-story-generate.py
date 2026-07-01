#!/usr/bin/env python3
"""
Generate story-chapter data from the local quest reference, applying wiki-verified
optional/required flags.

Sources (by authority):
- Local quest reference (eft/quest-list.json): objective existence, text, order,
  and source ids. A chapter is a named storyline quest on the narrator trader
  (67f7af56c117b6140af2a607); its objective conditions are ordered sub-quest refs
  whose own conditions carry the text.
- EFT wiki (data/eft/story-wiki-objectives.json via scripts/eft-story-wiki.py): the
  player-facing optional/required distinction, matched by fuzzy text.
- Curated (scripts/story-chapter-meta.json): chapter id/name/order/wikiLink/
  activation/requirements the reference lacks, plus The Ticket's branching
  objectives (endings + mutual exclusion), preserved verbatim.

Emits final storyChapters JSON to stdout. Deterministic given the inputs.
"""
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

REF = Path("eft/quest-list.json")
META = Path("scripts/story-chapter-meta.json")
WIKI = Path("data/eft/story-wiki-objectives.json")
NARRATOR_TRADER = "67f7af56c117b6140af2a607"
ID_RE = re.compile(r"[0-9a-fA-F]{24}")
MATCH_THRESHOLD = 0.6

CHAPTER_QUEST_ID = {
    "tour": "68cbd33676fe74b1e80bfd91",
    "falling-skies": "68cbcdc4c964ab83cc0c928e",
    "batya": "68da36cf7cff54fc6109874a",
    "the-unheard": "6900927ab7d28358f80b9421",
    "blue-fire": "68e784b7fa3f1fa3770094ba",
    "they-are-already-here": "6903d779fdfc4078740a4bd0",
    "accidental-witness": "69052e18e680c2d3e3034d3a",
    "the-labyrinth": "68e3a35002661eb2d30ce387",
    "the-ticket": "68da33fe00868edcb6025ac4",
    "boreas": "69d38381cea4b428690ea1d9",
}
PRESERVE_OBJECTIVES = {"the-ticket"}  # keep curated branching/endings verbatim


def bare(value):
    if not isinstance(value, str):
        return None
    m = ID_RE.search(value)
    return m.group(0) if m else None


def norm(text):
    text = text.lower()
    text = re.sub(r"\b\d[\d,]*\b", "#", text)   # collapse numbers
    text = re.sub(r"[^a-z# ]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def match_optional(text, wiki_objs):
    """Return (optional, best_ratio) for the closest wiki match.

    When the best match is below MATCH_THRESHOLD the objective is treated as
    required, returning (False, best_ratio) so the caller can log match quality.
    """
    nt = norm(text)
    best_ratio, best = 0.0, None
    for w in wiki_objs:
        r = SequenceMatcher(None, nt, norm(w["text"])).ratio()
        if r > best_ratio:
            best_ratio, best = r, w
    if best and best_ratio >= MATCH_THRESHOLD:
        return bool(best["optional"]), best_ratio
    return False, best_ratio


def load_reference():
    """Load the quest list from the local reference file.

    The reference is wrapped in a nested envelope; unwrap to the quest array,
    tolerating either the enveloped shape or a already-unwrapped `{data: [...]}`.
    """
    raw = json.loads(REF.read_text())
    node = raw.get("response", raw)
    node = node.get("decoded_response", node)
    data = node.get("data", node)
    return data


def main():
    quests = load_reference()
    byid = {bare(q["_id"]): q for q in quests}
    curated = json.loads(META.read_text())
    wiki = json.loads(WIKI.read_text()) if WIKI.exists() else {}
    if not wiki:
        print("warning: data/eft/story-wiki-objectives.json missing; run scripts/eft-story-wiki.py "
              "first (all objectives will be 'main')", file=sys.stderr)

    def en(q):
        return (q.get("localization") or {}).get("en", {}) or {}

    stats = {}

    def expand(chapter_id):
        chq = byid[CHAPTER_QUEST_ID[chapter_id]]
        wiki_objs = wiki.get(chapter_id, [])
        objs = []
        main_n = opt_n = matched = 0
        for c in chq.get("conditions", {}).get("AvailableForFinish", []) or []:
            if c.get("conditionType") != "Quest":
                continue
            tgt = c.get("target")
            tgt = tgt[0] if isinstance(tgt, list) and tgt else tgt
            sub = byid.get(bare(tgt))
            if not sub:
                continue
            sub_id = bare(sub["_id"])
            se = en(sub)
            for o in sub.get("conditions", {}).get("AvailableForFinish", []) or []:
                obj_id = o.get("id")
                if not obj_id:
                    continue  # skip conditions without an id
                text = (se.get(obj_id) or "").strip()
                if not text:
                    continue
                optional, ratio = match_optional(text, wiki_objs)
                if ratio >= MATCH_THRESHOLD:
                    matched += 1
                if optional:
                    opt_n += 1
                    oid = f"{chapter_id}-opt-{opt_n}"
                else:
                    main_n += 1
                    oid = f"{chapter_id}-main-{main_n}"
                objs.append({
                    "id": oid,
                    "type": "optional" if optional else "main",
                    "description": text,
                    "sourceQuestId": sub_id,
                    "sourceObjectiveId": obj_id,
                })
        stats[chapter_id] = {"objectives": len(objs), "matched": matched,
                             "optional": opt_n, "wiki": len(wiki_objs)}
        return objs

    out = {}
    for chapter_id in sorted(curated, key=lambda k: curated[k]["order"]):
        meta = curated[chapter_id]
        chapter = {
            "id": meta["id"],
            "name": meta["name"],
            "normalizedName": meta["normalizedName"],
            "wikiLink": meta["wikiLink"],
            "order": meta["order"],
            "chapterQuestId": CHAPTER_QUEST_ID[chapter_id],
            "autoStart": meta.get("autoStart", False),
            "chapterRequirements": meta.get("chapterRequirements", []),
        }
        if meta.get("activation"):
            chapter["activation"] = meta["activation"]
        chapter["description"] = meta.get("description")
        chapter["notes"] = meta.get("notes")
        if chapter_id in PRESERVE_OBJECTIVES and meta.get("objectives"):
            chapter["objectives"] = meta["objectives"]
        else:
            chapter["objectives"] = expand(chapter_id)
        chapter["rewards"] = meta.get("rewards")
        chapter["mapUnlocks"] = meta.get("mapUnlocks", [])
        chapter["traderUnlocks"] = meta.get("traderUnlocks", [])
        out[chapter_id] = chapter

    print("chapter match stats (eft objs / wiki-matched / optional):", file=sys.stderr)
    for cid, s in stats.items():
        pct = 100 * s["matched"] // max(s["objectives"], 1)
        print(f"  {cid:22s} objs={s['objectives']:3d} matched={pct:3d}% optional={s['optional']:2d} "
              f"wiki={s['wiki']}", file=sys.stderr)

    json.dump(out, sys.stdout, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
