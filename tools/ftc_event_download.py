#!/usr/bin/env python3
"""
Download an event's team list and qualification schedule from FIRST's official
FTC Events API and save it as a Hive Scout event file.

FIRST's API can't be called from a web page, so run this on a laptop with
internet, then AirDrop / copy the .json to an iPad and use
Event tab > File > Choose file (or Sync tab > Import).

Usage:
    python3 ftc_event_download.py 2026 USTXHOQ1
    (set FTC_API_USER and FTC_API_KEY first, or you will be asked for them)

Get a free username + authorization key at:
    https://ftc-events.firstinspires.org/services/API
"""
import base64
import getpass
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("FTC_API_BASE", "https://ftc-api.firstinspires.org/v2.0")


def get(path, auth):
    req = urllib.request.Request(BASE + path, headers={"Authorization": "Basic " + auth, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit("FIRST rejected the username/key (401). Check FTC_API_USER / FTC_API_KEY.")
        raise


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    season, code = sys.argv[1], sys.argv[2].upper()
    user = os.environ.get("FTC_API_USER") or input("FTC API username: ").strip()
    key = os.environ.get("FTC_API_KEY") or getpass.getpass("FTC API authorization key: ").strip()
    auth = base64.b64encode(f"{user}:{key}".encode()).decode()

    events = get(f"/{season}/events?eventCode={code}", auth).get("events") or []
    name = events[0]["name"] if events else code

    teams, page, pages = {}, 1, 1
    while page <= pages:
        data = get(f"/{season}/teams?eventCode={code}&page={page}", auth)
        for t in data.get("teams", []):
            teams[str(t["teamNumber"])] = t.get("nameShort") or t.get("nameFull") or ""
        pages = data.get("pageTotal") or 1
        page += 1

    sched = get(f"/{season}/schedule/{code}?tournamentLevel=qual", auth).get("schedule") or []
    matches = []
    for m in sched:
        def side(color):
            ts = [t for t in m.get("teams", []) if str(t.get("station", "")).lower().startswith(color)]
            ts.sort(key=lambda t: t.get("station", ""))
            return [t["teamNumber"] for t in ts if t.get("teamNumber")]
        matches.append({"n": m["matchNumber"], "r": side("red"), "b": side("blue")})
        for t in m.get("teams", []):
            if t.get("teamNumber") and str(t["teamNumber"]) not in teams:
                teams[str(t["teamNumber"])] = t.get("teamName") or ""

    out = {
        "hsEvent": 1, "code": code, "season": int(season), "name": name,
        "teams": teams, "matches": sorted(matches, key=lambda m: m["n"]), "src": "FIRST API",
    }
    fn = f"event-{code}.json"
    with open(fn, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"Saved {fn}: {name} - {len(teams)} teams, {len(matches)} qualification matches")


if __name__ == "__main__":
    main()
