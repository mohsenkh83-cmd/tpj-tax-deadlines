import json
import os
from pathlib import Path
from datetime import datetime

import jdatetime
from timeir import holiday_occasion

OUT = Path("holidays.json")

MONTHS = [
    "فروردین","اردیبهشت","خرداد","تیر","اَمرداد","شهریور",
    "مهر","آبان","آذر","دی","بهمن","اسفند"
]

# Keep site spelling compatible with current UI.
SITE_MONTHS = [
    "فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور",
    "مهر","آبان","آذر","دی","بهمن","اسفند"
]

def load_existing():
    if not OUT.exists():
        return {
            "source": "Time.ir",
            "source_url": "https://www.time.ir/event-year",
            "years": {}
        }
    try:
        return json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:
        return {
            "source": "Time.ir",
            "source_url": "https://www.time.ir/event-year",
            "years": {}
        }

def is_leap(year: int) -> bool:
    try:
        return bool(jdatetime.date(year, 1, 1).isleap())
    except Exception:
        return False

def days_in_month(year: int, month: int) -> int:
    if month <= 6:
        return 31
    if month <= 11:
        return 30
    return 30 if is_leap(year) else 29

def normalize_title(value):
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        parts = [str(x).strip() for x in value if str(x).strip()]
        return " / ".join(parts) if parts else None
    s = str(value).strip()
    return s or None

def fetch_year(year: int):
    result = {m: [] for m in SITE_MONTHS}
    holiday_count = 0

    for month in range(1, 13):
        for day in range(1, days_in_month(year, month) + 1):
            occasion = holiday_occasion(year, month, day)
            title = normalize_title(occasion)
            if title:
                result[SITE_MONTHS[month - 1]].append({
                    "day": day,
                    "title": title,
                    "source": "Time.ir"
                })
                holiday_count += 1

    return result, holiday_count

def target_years(existing):
    current = jdatetime.date.today().year
    event = os.getenv("GITHUB_EVENT_NAME", "")

    if event == "workflow_dispatch":
        # First/manual run: fill a useful archive plus near future.
        start = int(os.getenv("TIMEIR_START_YEAR", "1390"))
        end = int(os.getenv("TIMEIR_END_YEAR", str(current + 2)))
        return list(range(start, end + 1))

    # Scheduled runs: refresh only years likely to change/be newly published.
    return list(range(current - 1, current + 3))

def main():
    data = load_existing()
    data.setdefault("years", {})
    years = target_years(data)

    updated = []
    skipped = []

    for year in years:
        try:
            months, count = fetch_year(year)
            # A valid Iranian year should have at least some official holidays.
            if count == 0:
                skipped.append({"year": year, "reason": "no holiday data returned"})
                continue
            data["years"][str(year)] = months
            updated.append({"year": year, "holidays": count})
            print(f"{year}: {count} holidays")
        except Exception as exc:
            skipped.append({"year": year, "reason": repr(exc)})
            print(f"{year}: skipped: {exc!r}")

    data["source"] = "Time.ir"
    data["source_url"] = "https://www.time.ir/event-year"
    data["last_check_utc"] = datetime.utcnow().isoformat() + "Z"
    data["last_sync"] = {
        "updated": updated,
        "skipped": skipped
    }

    OUT.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    if not updated:
        raise SystemExit("No year could be refreshed from Time.ir.")

if __name__ == "__main__":
    main()
