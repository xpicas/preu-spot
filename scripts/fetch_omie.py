#!/usr/bin/env python3
"""Descarrega el preu marginal del mercat diari d'OMIE (zona ES) i el desa a data/AAAA-MM-DD.json.

- Font principal: fitxer marginalpdbc_AAAAMMDD.1 d'OMIE (96 quarts d'hora des de l'1/10/2025).
- Alternativa: API pública de REE (sèrie 600 "Precio mercado spot") si OMIE falla.
- Només escriu fitxers nous o que canvien. Escriu `changed=true|false` a $GITHUB_OUTPUT.

Ús: python scripts/fetch_omie.py [AAAA-MM-DD ...]   (per defecte: avui i demà, hora peninsular)
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Madrid")
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = "spot-price-pages/1.0 (+https://pages.github.com)"
OMIE_URL = "https://www.omie.es/es/file-download?parents%5B0%5D=marginalpdbc&filename=marginalpdbc_{ymd}.1"
REE_URL = (
    "https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real"
    "?start_date={d}T00:00&end_date={d}T23:59&time_trunc=hour"
)


def http_get(url: str, timeout: int = 30) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""


def local_midnight_utc(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=TZ).astimezone(timezone.utc)


def parse_omie(text: str, d: date) -> list[dict] | None:
    """Format: 'MARGINALPDBC;' + línies 'AAAA;MM;DD;periode;preu_PT;preu_ES;' + '*'."""
    rows: list[tuple[int, float]] = []
    for line in text.splitlines():
        f = [x.strip() for x in line.split(";")]
        if len(f) < 6 or not f[0].isdigit():
            continue
        y, m, dd, per = int(f[0]), int(f[1]), int(f[2]), int(f[3])
        if (y, m, dd) != (d.year, d.month, d.day):
            continue
        rows.append((per, float(f[5].replace(",", "."))))
    if not rows:
        return None
    rows.sort()
    n = len(rows)
    # 92/96/100 períodes -> 15 min; 23/24/25 -> horari (abans de l'1/10/2025)
    step = 60 if n <= 25 else 15
    start = local_midnight_utc(d)
    return [
        {"t": (start + timedelta(minutes=(per - 1) * step)).isoformat().replace("+00:00", "Z"), "p": round(p, 2)}
        for per, p in rows
    ]


def fetch_omie(d: date) -> list[dict] | None:
    status, body = http_get(OMIE_URL.format(ymd=d.strftime("%Y%m%d")))
    if status != 200 or not body.lstrip().upper().startswith(b"MARGINALPDBC"):
        return None
    return parse_omie(body.decode("latin-1"), d)


def fetch_ree(d: date) -> list[dict] | None:
    status, body = http_get(REE_URL.format(d=d.isoformat()))
    if status != 200:
        return None
    try:
        j = json.loads(body)
    except ValueError:
        return None
    serie = next((s for s in j.get("included", []) if s.get("id") == "600"), None)
    if not serie:
        return None
    out = []
    for v in serie["attributes"]["values"]:
        t = datetime.fromisoformat(v["datetime"])
        if t.astimezone(TZ).date() != d:
            continue
        out.append({"t": t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), "p": round(float(v["value"]), 2)})
    return out or None


def expected_periods(d: date, step: int) -> int:
    minutes = (local_midnight_utc(d + timedelta(days=1)) - local_midnight_utc(d)).total_seconds() / 60
    return int(minutes // step)


def process(d: date) -> bool:
    """Retorna True si s'ha escrit (o actualitzat) el fitxer del dia."""
    path = DATA / f"{d.isoformat()}.json"
    prices, source = fetch_omie(d), "OMIE"
    if not prices:
        prices, source = fetch_ree(d), "REE"
    if not prices:
        print(f"{d}: sense dades encara")
        return False
    step = 60 if len(prices) <= 25 else 15
    if len(prices) != expected_periods(d, step):
        print(f"{d}: {len(prices)} períodes (s'esperaven {expected_periods(d, step)}), no es desa")
        return False
    if path.exists():
        old = json.loads(path.read_text())
        if old.get("prices") == prices:
            print(f"{d}: sense canvis ({source})")
            return False
        if old.get("source") == "OMIE" and source != "OMIE":
            print(f"{d}: ja hi ha dades d'OMIE, no se sobreescriuen amb {source}")
            return False
    doc = {
        "date": d.isoformat(),
        "zone": "ES",
        "unit": "EUR/MWh",
        "resolution_min": step,
        "source": source,
        "updated": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "prices": prices,
    }
    DATA.mkdir(exist_ok=True)
    path.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    print(f"{d}: desat {len(prices)} preus ({source})")
    return True


def main(argv: list[str]) -> int:
    if argv:
        days = [date.fromisoformat(a) for a in argv]
    else:
        today = datetime.now(TZ).date()
        days = [today, today + timedelta(days=1)]
    changed = False
    for d in days:
        try:
            changed |= process(d)
        except Exception as e:  # una font caiguda no ha de trencar el workflow
            print(f"{d}: error {e!r}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
