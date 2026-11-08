"""
U9: Gemini "why" - one plain-English sentence explaining a /check result.

Privacy: Gemini only sees the level, score and reasons. Never coordinates or species lists.
Needs GEMINI_API_KEY in backend/.env. Model can be changed with GEMINI_MODEL.
Cached by result, so the same answer never costs a second call.
If Gemini fails or is slow, a plain template sentence is used instead.
"""
import os
import time

import requests

MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
BACKUP_MODELS = ["gemini-flash-lite-latest", "gemini-2.5-flash"]   # tried if the main one is busy
URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_cache = {}

PROMPT = """Explain a drone pre-flight result to a hobby drone pilot in ONE or TWO short sentences (max 35 words).
Start directly with the advice (no greeting, don't introduce yourself). Use only the facts below;
do not invent species, numbers, distances or places.
Overall result: {label} (risk score {score}/100)
What caused it: {cause}
{not_cause}
Advice already shown: {message}
"""

NAMES = {"nesting": "nesting birds", "raptors": "hawks or eagles", "powerlines": "power lines",
         "migration": "bird migration", "crowd": "people below", "air": "air quality",
         "wind": "wind", "rain": "rain", "visibility": "visibility", "clouds": "low clouds"}

LABEL = {"green": "Go", "yellow": "Wait", "red": "Don't fly"}


def fallback(result):
    reasons = result.get("reasons") or []
    lead = {"green": "Looks good to fly", "yellow": "Hold off for now",
            "red": "Don't fly here right now"}[result["level"]]
    if not reasons:
        return f"{lead}."
    first = reasons[0]
    return f"{lead}: {first[0].lower() + first[1:]}."     # keep "FAA" capitalised


def why(result):
    key = (result["level"], result["score"], tuple(result.get("reasons", [])), result.get("message"),
           tuple((h.get("type"), h.get("level")) for h in result.get("hazards") or []))
    if key in _cache:
        return _cache[key]
    api_key = os.environ.get("GEMINI_API_KEY")
    text = None
    if api_key:
        hz = [h for h in result.get("hazards") or [] if h.get("level") in ("green", "yellow", "red")]
        bad = sorted((h for h in hz if h["level"] in ("red", "yellow")),
                     key=lambda h: 0 if h["level"] == "red" else 1)
        if result["level"] == "green" or not bad:
            cause = "all checks passed (birds, power lines, weather and FAA rules)"
            not_cause = "Say it is clear to fly."
        else:
            cause = "; ".join(f"{h['detail']} ({h['level']})" for h in bad[:3])
            ok = sorted({NAMES.get(h["type"], h["type"]) for h in hz if h["level"] == "green"})
            not_cause = ("These checks PASSED, so do NOT mention them as a reason: "
                         + ", ".join(ok) + ".") if ok else ""
        prompt = PROMPT.format(label=LABEL[result["level"]], score=result["score"], cause=cause,
                               not_cause=not_cause, message=result.get("message", ""))
        for model in [MODEL] + [m for m in BACKUP_MODELS if m != MODEL]:
            for attempt in range(2):                 # one quick retry per model
                try:
                    text = _ask(model, prompt, api_key)
                    if text:
                        break
                except requests.HTTPError as e:
                    code = e.response.status_code if e.response is not None else 0
                    print(f"Gemini {model} error {code}")
                    if code in (429, 500, 503) and attempt == 0:
                        time.sleep(1)
                        continue
                    break                            # 404 etc: try the next model
                except Exception as e:
                    print(f"Gemini {model} failed: {e}")
                    break
            if text:
                break
    if not text:
        return fallback(result)                      # not cached, so it tries again next time
    _cache[key] = text
    return text


def _ask(model, prompt, api_key):
    r = requests.post(URL.format(model=model), timeout=6,
                      headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                      json={"contents": [{"parts": [{"text": prompt}]}],
                            # thinking models spend part of this budget before writing, so keep it roomy
                            "generationConfig": {"maxOutputTokens": 1024, "temperature": 0.4}})
    r.raise_for_status()
    cand = r.json()["candidates"][0]
    parts = (cand.get("content") or {}).get("parts") or []
    text = " ".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
    if cand.get("finishReason") == "MAX_TOKENS" or len(text) < 20:
        print(f"Gemini {model} gave a cut-off answer: {text!r}")
        return None                                   # try the next model / template
    return text
