#!/usr/bin/env python3
"""
Fetch story-chapter Objectives sections from the EFT wiki (MediaWiki api.php)
and parse each line into {text, optional}. Used to overlay player-facing
optional/required flags onto the story-chapter objective text.

Writes data/eft/story-wiki-objectives.json: { chapterId: [ {text, optional}, ... ] }
(derived output, gitignored). Exits non-zero if any chapter fails to parse.
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

WIKI_API = "https://escapefromtarkov.fandom.com/api.php"

# chapterId -> wiki page title
PAGES = {
    "tour": "Tour",
    "falling-skies": "Falling_Skies",
    "batya": "Batya",
    "the-unheard": "The_Unheard",
    "blue-fire": "Blue_Fire",
    "they-are-already-here": "They_Are_Already_Here",
    "accidental-witness": "Accidental_Witness",
    "the-labyrinth": "The_Labyrinth_(story_chapter)",
    "the-ticket": "The_Ticket",
    "boreas": "Boreas",
}

LINK_RE = re.compile(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]")
TAG_RE = re.compile(r"<[^>]+>")
OPT_RE = re.compile(r"\(\s*''+\s*optional\s*''+\s*\)", re.I)


def fetch_wikitext(title):
    url = f"{WIKI_API}?action=parse&page={title}&prop=wikitext&format=json"
    req = urllib.request.Request(url, headers={"User-Agent": "tarkov-data-overlay story extractor"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read().decode("utf-8"))
    if "error" in d:
        raise RuntimeError(f"{title}: {d['error'].get('info')}")
    return d["parse"]["wikitext"]["*"]


def clean(line):
    """Strip wiki markup to plain text, and report whether it's optional."""
    optional = bool(OPT_RE.search(line))
    line = OPT_RE.sub("", line)
    line = LINK_RE.sub(r"\1", line)          # [[A|B]] -> B, [[A]] -> A
    line = TAG_RE.sub("", line)              # drop <font>...</font>
    line = line.replace("'''", "").replace("''", "")
    line = re.sub(r"\s+", " ", line).strip(" *:")
    return line.strip(), optional


def parse_objectives(wikitext):
    m = re.search(r"==\s*Objectives\s*==(.*?)(\n==[^=]|\Z)", wikitext, re.S)
    if not m:
        return []
    out = []
    for raw in m.group(1).splitlines():
        s = raw.strip()
        if not s.startswith("*"):
            continue  # skip conditional headers ('''If...'''), <hr/>, blanks
        text, optional = clean(s)
        if text:
            out.append({"text": text, "optional": optional})
    return out


def main():
    out_dir = Path("data/eft")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "story-wiki-objectives.json"

    result = {}
    failures = []
    for cid, title in PAGES.items():
        try:
            wt = fetch_wikitext(title)
            objs = parse_objectives(wt)
            if not objs:
                raise RuntimeError("no objectives parsed from Objectives section")
            result[cid] = objs
            n_opt = sum(1 for o in objs if o["optional"])
            print(f"  {cid:22s} {len(objs):3d} objectives ({n_opt} optional)", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"  {cid:22s} FAILED: {e}", file=sys.stderr)
            failures.append(cid)

    with out_path.open("w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"wrote {out_path}", file=sys.stderr)

    if failures:
        # Fail loud: an empty/partial wiki set silently mislabels optionals
        # downstream, so do not let the pipeline continue on a clean exit.
        print(f"error: {len(failures)} chapter(s) failed: {', '.join(failures)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
