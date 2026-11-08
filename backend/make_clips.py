#!/usr/bin/env python3
"""
Pre-generate the demo's spoken alerts as MP3s, so the demo works offline and
costs almost nothing. Writes app/public/audio/*.mp3 and app/public/audio/clips.json
({spoken text: file}), which the app checks before calling /speak.

  python make_clips.py                 -> free model (s2.1-pro-free), for testing
  python make_clips.py --final         -> s2.1-pro, the clips we demo with
  python make_clips.py --api http://129.161.92.50:8000
                                       -> also adds the exact messages /check gives
                                          for the presets and the demo walk
"""
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

from speak import fish_tts

OUT = pathlib.Path(__file__).parent.parent / "app" / "public" / "audio"
LABELS = {"green": "Go", "yellow": "Wait", "red": "Don't fly"}

# Fallbacks the app plays if /speak is unreachable (one per level).
PHRASES = ["Go. Clear to fly.", "Wait. Check the warnings before you fly.", "Don't fly."]

PRESETS = [(42.7302, -73.6788, None), (42.7302, -73.6788, "2027-05-15"), (33.70, -118.04, "2021-05-13"),
           (42.7493, -73.694138, None)]
WALK = [(round(33.725 + (33.705 - 33.725) * i / 9, 5), round(-118.005 + (-118.045 + 118.005) * i / 9, 5), "2021-05-13")
        for i in range(10)]


RANK = {"red": 0, "yellow": 1, "green": 2}
ORDER = ["powerlines", "raptors", "wind", "clouds", "visibility", "rain", "nesting", "crowd", "migration", "air"]


def units(t):
    t = re.sub(r"(\d)\s?m\b", r"\1 meters", t)
    t = re.sub(r"(\d)\s?km\b", r"\1 kilometers", t)
    return re.sub(r"(\d)\s?ft\b", r"\1 feet", t)


def spoken(level, message, hazards=None):
    """Same rule as app/src/speech.js: worst red hazard's detail if any, else the message;
    say the level first unless the text already does."""
    label = LABELS.get(level, "Wait")
    reds = sorted((h for h in (hazards or []) if h.get("level") == "red" and h.get("detail")),
                  key=lambda h: ORDER.index(h["type"]) if h.get("type") in ORDER else 99)
    text = units((reds[0]["detail"] if reds else message or "").strip().rstrip("."))
    return text if text.lower().startswith(label.lower()) else f"{label}. {text}".strip()


def from_api(api):
    out = set()
    for lat, lon, date in PRESETS + WALK:
        q = {"lat": lat, "lon": lon} | ({"date": date} if date else {})
        print(f"checking {lat}, {lon} {date or 'today'} ...", end=" ", flush=True)
        try:
            with urllib.request.urlopen(f"{api.rstrip('/')}/check?{urllib.parse.urlencode(q)}", timeout=30) as r:
                d = json.load(r)
        except Exception as e:
            print("failed:", e)
            continue
        print(d["level"])
        out.add(spoken(d["level"], d["message"], d.get("hazards")))
    return sorted(out)


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] + ".mp3"


def main():
    model = "s2.1-pro" if "--final" in sys.argv else "s2.1-pro-free"
    texts = list(PHRASES)
    if "--api" in sys.argv:
        texts += [t for t in from_api(sys.argv[sys.argv.index("--api") + 1]) if t not in texts]
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / "clips.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for t in texts:
        name = slug(t)
        if (OUT / name).exists() and manifest.get(t) == name and "--final" not in sys.argv:
            print("already have", name)
            continue
        print(f"{model}: {t!r} -> {name}")
        (OUT / name).write_bytes(fish_tts(t, model=model))
        manifest[t] = name
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{len(texts)} clips, {sum(len(t.encode()) for t in texts)} bytes of text "
          f"(about ${sum(len(t.encode()) for t in texts) * 15 / 1e6:.4f})")


if __name__ == "__main__":
    main()
