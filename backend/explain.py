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
Rules: start directly with the advice (no greeting, don't introduce yourself). Use only the facts below;
do not invent species, numbers or places. The score is ONLY the bird-disturbance risk (0-100, under 30 is low,
60+ is high). The overall result can be stricter than the score because of wind or FAA weather rules - if so,
say that the weather or the FAA rule is the reason, not the birds.
Overall result: {label}
Bird risk score: {score}/100
Checks: {checks}
Reasons (most important first): {reasons}
Advice already shown: {message}

"""

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
    key = (result["level"], result["score"], tuple(result.get("reasons", [])), result.get("message"))
    if key in _cache:
        return _cache[key]
    api_key = os.environ.get("GEMINI_API_KEY")
    text = None
    if api_key:
        checks = ", ".join(f"{k} {v}" for k, v in (result.get("checks") or {}).items() if v)
        prompt = PROMPT.format(label=LABEL[result["level"]], score=result["score"],
                               checks=checks or "not available",
                               reasons="; ".join(result.get("reasons", [])) or "none",
                               message=result.get("message", ""))
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
