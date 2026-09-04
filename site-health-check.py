import json
import re
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

MONTHS = [
    "فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور",
    "مهر","آبان","آذر","دی","بهمن","اسفند"
]

ERRORS = []
WARNINGS = []

def error(msg):
    ERRORS.append(msg)
    print(f"ERROR: {msg}")

def warn(msg):
    WARNINGS.append(msg)
    print(f"WARNING: {msg}")

def load_json(path):
    p = Path(path)
    if not p.exists():
        error(f"{path} not found")
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        error(f"{path} is not valid JSON: {exc}")
        return {}

def to_en_digits(value):
    return str(value).translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789"))

def validate_deadlines():
    data = load_json("deadlines.json")
    if not data:
        return

    default_year = data.get("defaultYear")
    if not isinstance(default_year, int):
        error("deadlines.json: defaultYear must be an integer")

    months = data.get("months")
    if not isinstance(months, dict):
        error("deadlines.json: months must be an object")
        return

    missing = [m for m in MONTHS if m not in months]
    if missing:
        error("deadlines.json: missing month(s): " + ", ".join(missing))

    for month in MONTHS:
        items = months.get(month, [])
        if not isinstance(items, list):
            error(f"deadlines.json: {month} must be an array")
            continue

        seen = set()
        for i, item in enumerate(items, 1):
            if not isinstance(item, dict):
                error(f"deadlines.json: {month} item #{i} is not an object")
                continue

            title = str(item.get("title", "")).strip()
            typ = str(item.get("type", "")).strip()
            day = item.get("day")

            if not title:
                error(f"deadlines.json: {month} item #{i} has no title")
            if not typ:
                warn(f"deadlines.json: {month} / {title or i} has no type")

            if isinstance(day, int):
                if not 1 <= day <= 31:
                    error(f"deadlines.json: invalid day {day} in {month} / {title}")
            elif isinstance(day, str):
                s = to_en_digits(day).strip()
                if "پایان ماه" not in day and not re.search(r"\d{1,2}", s):
                    warn(f"deadlines.json: non-standard day '{day}' in {month} / {title}")
            else:
                error(f"deadlines.json: missing/invalid day in {month} / {title}")

            key = (str(day), title)
            if key in seen:
                warn(f"deadlines.json: duplicate item in {month}: {day} - {title}")
            seen.add(key)

    print("OK: deadlines.json structure checked")

def validate_holidays():
    data = load_json("holidays.json")
    if not data:
        return

    years = data.get("years")
    if not isinstance(years, dict):
        error("holidays.json: years must be an object")
        return

    deadlines = load_json("deadlines.json")
    default_year = deadlines.get("defaultYear") if isinstance(deadlines, dict) else None
    if default_year is not None and str(default_year) not in years:
        error(f"holidays.json: year {default_year} not found")

    for year, block in years.items():
        if not isinstance(block, dict):
            error(f"holidays.json: year {year} must be an object")
            continue

        missing = [m for m in MONTHS if m not in block]
        if missing:
            error(f"holidays.json: year {year} missing month(s): {', '.join(missing)}")

        for month in MONTHS:
            items = block.get(month, [])
            if not isinstance(items, list):
                error(f"holidays.json: {year}/{month} must be an array")
                continue

            for i, item in enumerate(items, 1):
                if not isinstance(item, dict):
                    error(f"holidays.json: {year}/{month} item #{i} is not an object")
                    continue
                try:
                    day = int(item.get("day"))
                except Exception:
                    error(f"holidays.json: {year}/{month} item #{i} has invalid day")
                    continue
                if not 1 <= day <= 31:
                    error(f"holidays.json: {year}/{month} invalid day {day}")
                if not str(item.get("title", "")).strip():
                    warn(f"holidays.json: {year}/{month}/{day} has no title")

    print("OK: holidays.json structure checked")

def validate_updates():
    data = load_json("latest-updates.json")
    if not data:
        return
    if "last_check_utc" not in data:
        warn("latest-updates.json: last_check_utc missing")
    items = data.get("items")
    if not isinstance(items, list):
        error("latest-updates.json: items must be an array")
    print("OK: latest-updates.json structure checked")

def validate_index():
    p = Path("index.html")
    if not p.exists():
        error("index.html not found")
        return

    text = p.read_text(encoding="utf-8", errors="replace")
    required_refs = ["deadlines.json", "holidays.json", "latest-updates.json"]
    for ref in required_refs:
        if ref not in text:
            error(f"index.html does not reference {ref}")

    if 'id="calendar"' not in text:
        error('index.html: calendar element id="calendar" not found')
    if "loadDeadlines" not in text:
        error("index.html: loadDeadlines() not found")
    if "loadHolidays" not in text:
        error("index.html: loadHolidays() not found")

    print("OK: index.html basic integration checked")

def check_url(url, label, fatal=False):
    try:
        req = Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 TPJ-Site-Health-Check/1.0"}
        )
        with urlopen(req, timeout=15) as r:
            status = getattr(r, "status", 200)
            if status >= 400:
                raise HTTPError(url, status, "bad status", hdrs=None, fp=None)
        print(f"OK: {label} reachable")
    except Exception as exc:
        msg = f"{label} check failed: {exc}"
        if fatal:
            error(msg)
        else:
            warn(msg)

def validate_links():
    # External services can temporarily reject automated requests,
    # therefore link failures are warnings, not deployment-blocking errors.
    links = [
        ("https://es.tamin.ir/", "Tamin"),
        ("https://salary.tax.gov.ir/", "Salary Tax"),
        ("https://my.tax.gov.ir/", "MyTax"),
        ("https://www.taghvim.com/", "Taghvim"),
    ]
    for url, label in links:
        check_url(url, label, fatal=False)

def main():
    print("=== TPJ Site Health Check ===")
    validate_deadlines()
    validate_holidays()
    validate_updates()
    validate_index()
    validate_links()

    print()
    print(f"Warnings: {len(WARNINGS)}")
    print(f"Errors: {len(ERRORS)}")

    if ERRORS:
        print("RESULT: FAILED")
        sys.exit(1)

    print("RESULT: PASSED")

if __name__ == "__main__":
    main()
