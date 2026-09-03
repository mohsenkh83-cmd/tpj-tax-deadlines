import json
import re
import hashlib
from pathlib import Path
from datetime import datetime, timezone

import requests
from pypdf import PdfReader

SOURCES = Path("calendar-sources.json")
CANDIDATE = Path("holidays-candidate.json")
PDF_DIR = Path("calendar-pdf")
PDF_DIR.mkdir(exist_ok=True)

MONTHS = [
    "فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور",
    "مهر","آبان","آذر","دی","بهمن","اسفند"
]

HOLIDAY_HINTS = [
    "تعطیل", "نوروز", "جمهوری اسلامی", "روز طبیعت",
    "رحلت", "شهادت", "ولادت", "عید", "تاسوعا", "عاشورا",
    "اربعین", "قیام ۱۵ خرداد", "پیروزی انقلاب اسلامی",
    "ملی شدن صنعت نفت"
]

def fa_to_en(s):
    return str(s).translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹", "0123456789"))

def load_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback

def newest_year_source():
    data = load_json(SOURCES, {})
    years = data.get("years", {})
    if not years:
        raise SystemExit("No official calendar source is available in calendar-sources.json")
    year = max(int(y) for y in years.keys())
    return year, years[str(year)]

def download(url, path):
    r = requests.get(url, timeout=60, headers={"User-Agent":"TPJ-Calendar-Candidate/1.0"})
    r.raise_for_status()
    path.write_bytes(r.content)
    return hashlib.sha256(r.content).hexdigest()

def extract_text(pdf_path):
    reader = PdfReader(str(pdf_path))
    pages = []
    for i, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append({"page": i, "text": text})
    return pages

def split_lines(pages):
    out = []
    for p in pages:
        for line in (p["text"] or "").splitlines():
            line = " ".join(line.split())
            if line:
                out.append({"page": p["page"], "line": line})
    return out

def detect_candidates(lines):
    candidates = []
    current_month = None

    for item in lines:
        line = item["line"]

        for m in MONTHS:
            if m in line:
                current_month = m
                break

        if not any(h in line for h in HOLIDAY_HINTS):
            continue

        nums = re.findall(r"[0-9۰-۹]{1,2}", line)
        day = None
        if nums:
            try:
                n = int(fa_to_en(nums[0]))
                if 1 <= n <= 31:
                    day = n
            except Exception:
                pass

        candidates.append({
            "month": current_month,
            "day": day,
            "title_raw": line,
            "page": item["page"],
            "confidence": "candidate_only",
            "approved": False
        })

    # Deduplicate exact raw lines/page combinations
    seen = set()
    deduped = []
    for c in candidates:
        k = (c["page"], c["title_raw"])
        if k not in seen:
            seen.add(k)
            deduped.append(c)
    return deduped

def main():
    year, src = newest_year_source()
    pdf_url = src.get("calendar_pdf")
    if not pdf_url:
        raise SystemExit(f"No calendar_pdf URL for year {year}")

    pdf_path = PDF_DIR / f"official-calendar-{year}.pdf"
    sha = download(pdf_url, pdf_path)
    pages = extract_text(pdf_path)
    lines = split_lines(pages)
    candidates = detect_candidates(lines)

    payload = {
        "year": year,
        "official_source": "مرکز تقویم مؤسسه ژئوفیزیک دانشگاه تهران",
        "calendar_pdf": pdf_url,
        "pdf_sha256": sha,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "status": "needs_manual_review",
        "warning": (
            "این فایل فقط پیشنهاد استخراج‌شده از متن PDF رسمی است. "
            "هیچ موردی تا زمان بررسی و تایید دستی نباید به holidays.json منتقل شود."
        ),
        "candidates": candidates
    }

    CANDIDATE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    print(f"Generated {CANDIDATE} with {len(candidates)} candidate item(s) for {year}.")

if __name__ == "__main__":
    main()
