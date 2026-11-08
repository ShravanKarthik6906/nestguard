"""
U9: Gemini "why" - one plain-English sentence explaining a /check result.

Privacy: Gemini only sees the risk score, hazard details and reasons. Never coordinates or species lists.
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

PROMPT = """Explain a drone pre-flight risk score to a hobby drone pilot in ONE or TWO short sentences (max 35 words).
Start directly (no greeting, don't introduce yourself). Use only the facts below;
do not invent species, numbers, distances or places.
Do NOT give a verdict: never say "go", "wait", "don't fly", "safe to fly" or "clear to fly".
Describe how risky it is and what drives the risk; the pilot decides.
Risk score: {score}/100
What drives it: {cause}
{not_cause}
Summary already shown: {message}
"""

NAMES = {"nesting": "nesting birds", "raptors": "hawks or eagles", "powerlines": "power lines",
         "migration": "bird migration", "crowd": "people below", "air": "air quality",
         "wind": "wind", "rain": "rain", "visibility": "visibility", "clouds": "low clouds"}

def fallback(result):
    """Plain template: the summary line already names the score and its main driver."""
    msg = (result.get("message") or "").rstrip(".")
    return f"{msg}." if msg else f"Risk {result.get('score')}/100."


def why(result):
    key = (result["score"], tuple(result.get("reasons", [])), result.get("message"),
           tuple((h.get("type"), h.get("level")) for h in result.get("hazards") or []))
    if key in _cache:
        return _cache[key]
    api_key = os.environ.get("GEMINI_API_KEY")
    text = None
    if api_key:
        hz = [h for h in result.get("hazards") or [] if h.get("level") in ("green", "yellow", "red")]
        bad = sorted((h for h in hz if h["level"] in ("red", "yellow")),
                     key=lambda h: 0 if h["level"] == "red" else 1)
        if not bad:
            cause = "no hazards found (birds, power lines, weather and FAA rules all low)"
            not_cause = "Say the risk is low."
        else:
            band = {"red": "high risk", "yellow": "medium risk"}
            cause = "; ".join(f"{h['detail']} ({band[h['level']]})" for h in bad[:3])
            ok = sorted({NAMES.get(h["type"], h["type"]) for h in hz if h["level"] == "green"})
            not_cause = ("These checks are LOW risk, so do NOT mention them as a cause: "
                         + ", ".join(ok) + ".") if ok else ""
        prompt = PROMPT.format(score=result["score"], cause=cause,
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
