import json
import re
from pathlib import Path
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

CHANNEL = "https://t.me/s/PRGeophysics"
OUT = Path("calendar-sources.json")

HEADERS = {
    "User-Agent": "Mozilla/5.0 TPJ-Official-Calendar-Monitor/1.0"
}

def load_existing():
    if not OUT.exists():
        return {"source": "مرکز تقویم مؤسسه ژئوفیزیک دانشگاه تهران", "years": {}}
    try:
        return json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:
        return {"source": "مرکز تقویم مؤسسه ژئوفیزیک دانشگاه تهران", "years": {}}

def discover():
    r = requests.get(CHANNEL, headers=HEADERS, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    found = {}
    for wrap in soup.select(".tgme_widget_message_wrap"):
        text_el = wrap.select_one(".tgme_widget_message_text")
        if not text_el:
            continue

        text = " ".join(text_el.get_text(" ", strip=True).split())
        m = re.search(r"تقویم\s+سال\s+([0-9۰-۹]{4})\s+هجری\s+شمسی", text)
        if not m:
            continue

        persian_digits = "۰۱۲۳۴۵۶۷۸۹"
        latin_digits = "0123456789"
        year_text = m.group(1).translate(str.maketrans(persian_digits, latin_digits))
        year = int(year_text)

        links = [a.get("href","") for a in wrap.select("a[href]")]
        pdf = next((u for u in links if "calendar.ut.ac.ir" in u and re.search(r"Calendar-\d{4}\.pdf", u, re.I)), "")
        abstract = next((u for u in links if "calendar.ut.ac.ir" in u and "abstract-" in u.lower() and u.lower().endswith(".pdf")), "")

        if pdf:
            found[str(year)] = {
                "calendar_pdf": pdf,
                "abstract_pdf": abstract,
                "discovered_at_utc": datetime.now(timezone.utc).isoformat(),
                "verified_source": True
            }

    return found

data = load_existing()
before = set(data.get("years", {}).keys())
found = discover()

data.setdefault("years", {}).update(found)
data["source"] = "مرکز تقویم مؤسسه ژئوفیزیک دانشگاه تهران"
data["source_channel"] = CHANNEL
data["last_check_utc"] = datetime.now(timezone.utc).isoformat()

OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

after = set(data["years"].keys())
new_years = sorted(after - before)

if new_years:
    Path("calendar-new-year.md").write_text(
        "# تقویم رسمی جدید شناسایی شد\n\n"
        + "\n".join(
            f"- سال {y}: {data['years'][y]['calendar_pdf']}" for y in new_years
        )
        + "\n\nمنبع: مرکز تقویم مؤسسه ژئوفیزیک دانشگاه تهران\n"
          "قبل از انتقال تعطیلات به holidays.json، نسخه رسمی باید بررسی شود.\n",
        encoding="utf-8"
    )
    print("New official calendar year(s):", ", ".join(new_years))
else:
    p = Path("calendar-new-year.md")
    if p.exists():
        p.unlink()
    print("No new official calendar year found.")
