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

PRESETS = [(42.7302, -73.6788, None), (42.7302, -73.6788, "2027-05-15"), (33.70, -118.04, "2021-05-13")]
WALK = [(round(33.725 + (33.705 - 33.725) * i / 9, 5), round(-118.005 + (-118.045 + 118.005) * i / 9, 5), "2021-05-13")
        for i in range(10)]


def spoken(level, message):
    """Same rule as app/src/speech.js: say the level first unless the message already does."""
    label = LABELS.get(level, "Wait")
    message = (message or "").strip()
    return message if message.lower().startswith(label.lower()) else f"{label}. {message}".strip()


def from_api(api):
    out = set()
    for lat, lon, date in PRESETS + WALK:
        q = {"lat": lat, "lon": lon} | ({"date": date} if date else {})
        with urllib.request.urlopen(f"{api.rstrip('/')}/check?{urllib.parse.urlencode(q)}", timeout=30) as r:
            d = json.load(r)
        out.add(spoken(d["level"], d["message"]))
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
        print(f"{model}: {t!r} -> {name}")
        (OUT / name).write_bytes(fish_tts(t, model=model))
        manifest[t] = name
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{len(texts)} clips, {sum(len(t.encode()) for t in texts)} bytes of text "
          f"(about ${sum(len(t.encode()) for t in texts) * 15 / 1e6:.4f})")


if __name__ == "__main__":
    main()
