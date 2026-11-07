"""
POST /speak {"text": "..."} -> audio/mpeg, spoken by Fish Audio.

The Fish Audio key stays on the server (FISH_AUDIO_API_KEY in backend/.env);
the browser only ever gets the MP3. Each distinct sentence is generated once and
kept in backend/audio_cache/, so repeats are free and work if Fish is down.

Udaya adds to main.py:
    from speak import router
    app.include_router(router)
"""
import hashlib
import json
import os
import pathlib
import urllib.request

from fastapi import APIRouter, Body, HTTPException, Response

try:
    from dotenv import load_dotenv
    load_dotenv(pathlib.Path(__file__).parent / ".env")
except ImportError:
    pass

FISH_URL = "https://api.fish.audio/v1/tts"
MODEL = os.environ.get("FISH_MODEL", "s2.1-pro-free")   # "s2.1-pro" only for the final demo clips
CACHE = pathlib.Path(__file__).parent / "audio_cache"
MAX_CHARS = 200                                          # keeps cost bounded

router = APIRouter()


def fish_tts(text, model=MODEL):
    """Call Fish Audio and return MP3 bytes."""
    key = os.environ.get("FISH_AUDIO_API_KEY")
    if not key:
        raise RuntimeError("FISH_AUDIO_API_KEY is not set in backend/.env")
    body = {"text": text, "format": "mp3"}
    if os.environ.get("FISH_VOICE_ID"):                  # optional voice from fish.audio
        body["reference_id"] = os.environ["FISH_VOICE_ID"]
    req = urllib.request.Request(
        FISH_URL, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "model": model})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


@router.post("/speak")
def speak(body: dict = Body(...)):
    text = str(body.get("text", "")).strip()
    if not text or len(text) > MAX_CHARS:
        raise HTTPException(400, f"text must be 1-{MAX_CHARS} characters")
    path = CACHE / (hashlib.sha1(f"{MODEL}|{text}".encode()).hexdigest()[:16] + ".mp3")
    if not path.exists():
        try:
            audio = fish_tts(text)
        except Exception as e:
            print("Fish Audio failed:", e)
            raise HTTPException(502, "speech unavailable")
        CACHE.mkdir(exist_ok=True)
        path.write_bytes(audio)
    return Response(path.read_bytes(), media_type="audio/mpeg")
