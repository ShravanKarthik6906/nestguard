"""
U4: NestGuard risk score (0-100) and Go / Wait / Don't fly level.

For every blurred zone near the pilot:
  zone_risk = proximity x amount x recency x season x group
    proximity  1 inside the zone, then fades with distance from its edge (half by ~350 m)
    amount     more sightings = more risk (levels off around 20)
    recency    recent sightings count more (fades over ~30 days before the check date)
    season     1.0 if any species group there is nesting that month, else 0.15
    group      colony nesters x1.5, raptors x1.2 (only during nesting season)
Zones combine like independent chances: risk = 1 - (1-r1)(1-r2)...
score = 100 x risk.  red >= 60, yellow >= 30, else green.

U5 multiplies the final risk by a weather factor (cold or rain = 1.3).
"""
import datetime
import math

RED_AT, YELLOW_AT = 60, 30
NEAR_KM = 2.0                      # zones farther than this from the pilot are ignored

# species groups: name keywords, keep-away buffer (from the build plan), nesting months
GROUPS = {
    "colony": {"words": ("tern", "gull", "skimmer", "heron", "egret", "cormorant",
                         "pelican", "ibis", "stilt", "avocet"),
               "buffer_m": 170, "months": range(4, 9)},          # Apr-Aug
    "raptor": {"words": ("hawk", "eagle", "falcon", "osprey", "kite", "harrier",
                         "kestrel", "merlin", "owl", "vulture"),
               "buffer_m": 30, "months": range(2, 8)},           # Feb-Jul
    "large":  {"words": ("goose", "swan", "crane", "turkey", "loon"),
               "buffer_m": 30, "months": range(3, 8)},           # Mar-Jul
    "medium": {"words": ("duck", "mallard", "teal", "crow", "raven", "pigeon", "dove",
                         "woodpecker", "flicker", "jay", "grackle", "killdeer"),
               "buffer_m": 50, "months": range(3, 8)},
    "small":  {"words": (), "buffer_m": 70, "months": range(4, 9)},  # everything else
}


def group_of(name):
    n = (name or "").lower()
    for g, info in GROUPS.items():
        if any(w in n for w in info["words"]):
            return g
    return "small"


def dist_m(a, b, c, d):
    p1, p2 = math.radians(a), math.radians(c)
    h = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(d - b) / 2) ** 2)
    return 12742000 * math.asin(math.sqrt(h))


def nesting_month(month, lat):
    return month if lat >= 0 else (month + 5) % 12 + 1    # flip seasons south of the equator


def zone_risk(zone, date, pilot=None):
    """Returns (risk 0-1, details dict). pilot=None means 'standing in the zone'."""
    groups = {group_of(s) for s in zone.get("species", [])} or {"small"}
    if zone.get("raptors"):
        groups.add("raptor")
    if zone.get("colony"):
        groups.add("colony")

    if pilot is None:
        edge = 0.0
    else:
        edge = max(0.0, dist_m(pilot[0], pilot[1], zone["lat"], zone["lon"]) - zone.get("radius_m", 500))
    proximity = math.exp(-edge / 500)

    n = zone.get("sightings", 1)
    amount = 0.4 + 0.6 * min(1.0, math.log1p(n) / math.log1p(20))

    try:
        latest = datetime.date.fromisoformat(str(zone.get("latest", ""))[:10])
        days = abs((date - latest).days)
    except ValueError:
        days = 60
    recency = 0.3 + 0.7 * math.exp(-days / 30)

    month = nesting_month(date.month, zone["lat"])
    nesting = sorted(g for g in groups if month in GROUPS[g]["months"])
    season = 1.0 if nesting else 0.15

    weight = 1.0
    if "colony" in nesting:
        weight *= 1.5
    if "raptor" in nesting:
        weight *= 1.2

    risk = min(1.0, proximity * amount * recency * season * weight)
    return risk, {"edge_m": edge, "groups": groups, "nesting": nesting, "sightings": n,
                  "buffer_m": max(GROUPS[g]["buffer_m"] for g in groups)}


def level_for(score):
    return "red" if score >= RED_AT else "yellow" if score >= YELLOW_AT else "green"


def public_zone(zone, date):
    """Zone as the app/device sees it, with a level for this date (no species lists)."""
    r, _ = zone_risk(zone, date)
    return {"lat": zone["lat"], "lon": zone["lon"], "radius_m": zone.get("radius_m", 500),
            "level": level_for(round(r * 100))}


def score(lat, lon, date, zones, weather_mult=1.0, weather_reasons=()):
    near = [z for z in zones
            if dist_m(lat, lon, z["lat"], z["lon"]) - z.get("radius_m", 500) <= NEAR_KM * 1000]
    keep_out = 1.0
    details = []
    for z in near:
        r, d = zone_risk(z, date, (lat, lon))
        keep_out *= 1 - r
        details.append((r, z, d))
    risk = min(1.0, (1 - keep_out) * weather_mult)
    s = round(risk * 100)
    level = level_for(s)

    # ---- reasons, most important first
    reasons = []
    within_1km = [d for r, z, d in details if d["edge_m"] <= 1000]
    raptor_n = sum(d["sightings"] for d in within_1km if "raptor" in d["groups"])
    colony_n = sum(d["sightings"] for d in within_1km if "colony" in d["groups"])
    total_n = sum(d["sightings"] for d in within_1km)
    nesting_now = sorted({g for d in within_1km for g in d["nesting"]})
    inside = any(d["edge_m"] == 0 for d in within_1km)

    if raptor_n:
        reasons.append("Hawk or eagle sightings within 1 km")
    if colony_n:
        reasons.append("Colony nesters nearby (terns, gulls, herons)")
    if nesting_now:
        reasons.append("Nesting season for " + ", ".join(nesting_now) + " birds")
    elif within_1km:
        reasons.append("Outside nesting season")
    if total_n:
        reasons.append(f"{total_n} recent sightings within 1 km")
    if not near:
        reasons.append("No recent bird activity within 2 km")
    reasons += list(weather_reasons)

    buffer_m = max([d["buffer_m"] for r, z, d in details if r >= 0.3], default=70)
    if level == "red":
        message = ("Inside a nesting zone, don't fly here" if inside
                   else f"Nesting zone close by, stay {buffer_m} m away or climb to 300 ft")
    elif level == "yellow":
        message = f"Birds nearby, keep at least {buffer_m} m away"
    else:
        message = "Clear to fly"

    raptor_alert = None
    if raptor_n:
        raptor_alert = ("Hawks or eagles seen within 1 km. They can attack drones, "
                        "especially near their nests. Watch the sky and land if one comes close.")

    return {"level": level, "score": s, "message": message, "reasons": reasons,
            "raptor_alert": raptor_alert,
            "nesting_until": nesting_until(nesting_now, date),
            "base_risk": 1 - keep_out,                 # before weather; used by best_time
            "zones": [public_zone(z, date) for z in near]}


MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]


def nesting_until(groups, date):
    """Name of the month nesting ends for these groups (northern-hemisphere months)."""
    if not groups:
        return None
    last = max(max(GROUPS[g]["months"]) for g in groups)
    return MONTHS[last - 1]
