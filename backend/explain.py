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
do not invent species, numbers or places.
Overall result: {label}
What caused it: {cause}
{not_cause}
Reasons (most important first): {reasons}
Advice already shown: {message}
"""

CAUSE = {"wildlife": "nesting birds and bird activity nearby (bird risk score {score}/100)",
         "safety": "wind or rain that makes flying unsafe",
         "legal": "FAA weather rules (visibility or cloud clearance)"}

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
           tuple(sorted((result.get("checks") or {}).items())))
    if key in _cache:
        return _cache[key]
    api_key = os.environ.get("GEMINI_API_KEY")
    text = None
    if api_key:
        checks = result.get("checks") or {}
        bad = [k for k in ("legal", "safety", "wildlife") if checks.get(k) in ("red", "yellow")]
        if result["level"] == "green" or not bad:
            cause = "all checks passed (birds, weather and FAA rules are all fine)"
            not_cause = "Say it is clear to fly; mention any caution in the reasons briefly."
        else:
            cause = "; ".join(CAUSE[k].format(score=result["score"]) for k in bad)
            ok = [k for k in ("wildlife", "safety", "legal") if k not in bad and checks.get(k) == "green"]
            names = {"wildlife": "birds", "safety": "wind or rain", "legal": "weather or FAA rules"}
            not_cause = ("These checks PASSED, so do NOT mention them as a reason: "
                         + ", ".join(names[k] for k in ok) + ".") if ok else ""
        prompt = PROMPT.format(label=LABEL[result["level"]], cause=cause, not_cause=not_cause,
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
