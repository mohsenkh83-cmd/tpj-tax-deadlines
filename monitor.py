import json
import re
import sys
from pathlib import Path
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

SOURCES = [
    {
        "name": "سازمان امور مالیاتی کشور",
        "url": "https://t.me/s/inta_press",
        "keywords": [
            "مهلت", "تمدید", "اظهارنامه", "ارزش افزوده", "بخشنامه",
            "مالیات", "عملکرد", "مواعید", "معاملات فصلی", "حقوق"
        ],
    },
    {
        "name": "سازمان تأمین اجتماعی",
        "url": "https://t.me/s/tamin_media",
        "keywords": [
            "مهلت", "تمدید", "لیست", "حق بیمه", "بیمه", "کارفرما",
            "ارسال لیست", "پرداخت حق‌بیمه", "مواعید"
        ],
    },
]

STATE_FILE = Path("monitor-state.json")
ALERT_FILE = Path("alerts-new.md")
LATEST_FILE = Path("latest-updates.json")
DEADLINES_FILE = Path("deadlines.json")
CHANGE_LOG_FILE = Path("deadline-changes.json")

HEADERS = {
    "User-Agent": "Mozilla/5.0 TPJ-Tax-Deadline-Monitor/2.0"
}

MONTHS = {
    "فروردین": 1, "اردیبهشت": 2, "خرداد": 3, "تیر": 4,
    "مرداد": 5, "شهریور": 6, "مهر": 7, "آبان": 8,
    "آذر": 9, "دی": 10, "بهمن": 11, "اسفند": 12,
}
MONTH_NAMES = list(MONTHS.keys())

TASK_PATTERNS = [
    ("اظهارنامه عملکرد اشخاص حقیقی", ["اظهارنامه", "اشخاص حقیقی", "عملکرد"]),
    ("اظهارنامه عملکرد اشخاص حقوقی", ["اظهارنامه", "اشخاص حقوقی", "عملکرد"]),
    ("فرم مالیات مقطوع تبصره ماده ۱۰۰", ["تبصره", "۱۰۰"]),
    ("اظهارنامه و پرداخت مالیات بر ارزش افزوده", ["ارزش افزوده"]),
    ("گزارش معاملات فصلی", ["معاملات فصلی"]),
    ("ارسال فهرست و پرداخت مالیات حقوق", ["مالیات حقوق", "فهرست حقوق", "لیست حقوق"]),
    ("ارسال لیست و پرداخت حق بیمه", ["حق بیمه", "لیست بیمه", "ارسال لیست"]),
    ("بارگذاری دفاتر الکترونیکی", ["دفاتر الکترونیکی", "دفاتر تجاری"]),
]

def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()

def fa_to_en(s: str) -> str:
    return str(s).translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹", "0123456789"))

def en_to_fa(s: str) -> str:
    return str(s).translate(str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹"))

def fetch_messages(source):
    response = requests.get(source["url"], headers=HEADERS, timeout=30)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    messages = []

    for wrap in soup.select(".tgme_widget_message_wrap"):
        post = wrap.select_one(".tgme_widget_message")
        if not post:
            continue

        post_id = post.get("data-post", "")
        text_el = wrap.select_one(".tgme_widget_message_text")
        if not text_el:
            continue

        text = normalize(text_el.get_text(" ", strip=True))
        if not text:
            continue

        if not any(keyword in text for keyword in source["keywords"]):
            continue

        date_el = wrap.select_one("time")
        dt = date_el.get("datetime", "") if date_el else ""

        link_el = wrap.select_one("a.tgme_widget_message_date")
        link = link_el.get("href", "") if link_el else ""

        messages.append(
            {
                "source": source["name"],
                "id": post_id or link or text[:80],
                "date": dt,
                "link": link,
                "text": text,
            }
        )

    return messages[-20:]

def load_json(path, fallback):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback

def save_json(path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

def load_state():
    return load_json(STATE_FILE, {"initialized": False, "seen": []})

def save_state(seen, now_iso):
    payload = {
        "initialized": True,
        "last_check_utc": now_iso,
        "seen": sorted(set(seen))[-500:],
    }
    save_json(STATE_FILE, payload)

def save_latest(all_relevant, now_iso):
    unique = {}
    for item in all_relevant:
        key = item.get("id") or item.get("link") or item.get("text", "")[:80]
        unique[key] = item

    items = list(unique.values())
    items.sort(key=lambda x: x.get("date") or "", reverse=True)

    payload = {
        "last_check_utc": now_iso,
        "items": [
            {
                "source": item.get("source", ""),
                "date": item.get("date", ""),
                "link": item.get("link", ""),
                "text": item.get("text", ""),
            }
            for item in items[:10]
        ],
    }
    save_json(LATEST_FILE, payload)

def detect_task(text):
    t = text
    for canonical, clues in TASK_PATTERNS:
        if all(clue in t for clue in clues):
            return canonical
    return None

def detect_new_deadline(text):
    """
    Safe parser: only returns a date if a Persian month + day is explicitly
    present near words like تمدید / مهلت / تا تاریخ.
    """
    t = fa_to_en(text)

    patterns = [
        r"(?:تمدید(?:\s+شد)?|مهلت|تا\s+تاریخ|تا)\s*(?:تا\s*)?(\d{1,2})\s+(فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s*(14\d{2})?",
        r"(\d{1,2})\s+(فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s*(14\d{2})?\s*(?:تمدید|مهلت)",
    ]

    for p in patterns:
        m = re.search(p, t)
        if not m:
            continue
        day = int(m.group(1))
        month = m.group(2)
        year = int(m.group(3)) if m.group(3) else None
        if 1 <= day <= 31 and month in MONTHS:
            return {"day": day, "month": month, "year": year}
    return None

def detect_period(text):
    periods = [
        "زمستان", "بهار", "تابستان", "پاییز",
        "اسفند", "فروردین", "اردیبهشت", "خرداد", "تیر",
        "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن"
    ]
    found = [p for p in periods if p in text]
    return " / ".join(found[:3]) if found else ""

def candidate_from_notice(item):
    text = item.get("text", "")
    task = detect_task(text)
    deadline = detect_new_deadline(text)

    if not task or not deadline:
        return None

    # We only auto-apply if the notice explicitly talks about extension/deadline.
    if "تمدید" not in text and "مهلت" not in text:
        return None

    return {
        "task": task,
        "deadline": deadline,
        "period_hint": detect_period(text),
        "source": item.get("source", ""),
        "source_link": item.get("link", ""),
        "source_date": item.get("date", ""),
        "source_text": text,
    }

def month_end_day(month_name, year):
    idx = MONTHS[month_name]
    if idx <= 6:
        return 31
    if idx <= 11:
        return 30
    # conservative: 29 for Esfand unless explicit existing deadline says otherwise
    return 29

def normalize_day(day, month_name, year):
    if isinstance(day, int):
        return day
    s = fa_to_en(str(day))
    if "پایان ماه" in str(day):
        return month_end_day(month_name, year)
    m = re.search(r"\d{1,2}", s)
    return int(m.group(0)) if m else None

def apply_deadline_change(candidate, now_iso):
    data = load_json(DEADLINES_FILE, {"defaultYear": 1405, "months": {}})
    months = data.setdefault("months", {})
    new_month = candidate["deadline"]["month"]
    new_day = candidate["deadline"]["day"]
    target_year = candidate["deadline"]["year"] or int(data.get("defaultYear", 1405))
    task = candidate["task"]

    # Find best existing match by title and optional period hint.
    matches = []
    for month_name, items in months.items():
        for idx, e in enumerate(items or []):
            title = str(e.get("title", ""))
            if task not in title and title not in task:
                continue

            score = 1
            period_hint = candidate.get("period_hint", "")
            if period_hint and any(p in str(e.get("period", "")) for p in period_hint.split(" / ") if p):
                score += 2

            matches.append((score, month_name, idx, e))

    if not matches:
        return {"applied": False, "reason": "no matching deadline record"}

    matches.sort(key=lambda x: x[0], reverse=True)
    _, old_month, old_idx, old_event = matches[0]

    old_day = normalize_day(old_event.get("day"), old_month, target_year)

    updated = dict(old_event)
    updated["day"] = new_day
    updated["title"] = old_event.get("title", task)
    updated["period"] = (
        f"{old_event.get('period','')} | تمدیدشده طبق اطلاعیه {candidate['source']}"
    ).strip(" |")
    updated["source"] = candidate.get("source_link") or candidate.get("source")
    updated["updated_at_utc"] = now_iso
    updated["previous_deadline"] = {
        "month": old_month,
        "day": old_event.get("day"),
    }

    # Remove old record, add updated record in new month.
    del months[old_month][old_idx]
    months.setdefault(new_month, []).append(updated)

    # Sort numeric dates first.
    def sort_key(e):
        d = normalize_day(e.get("day"), new_month, target_year)
        return d if d is not None else 99

    months[new_month] = sorted(months[new_month], key=sort_key)

    save_json(DEADLINES_FILE, data)

    log = load_json(CHANGE_LOG_FILE, {"changes": []})
    log.setdefault("changes", []).append({
        "applied_at_utc": now_iso,
        "task": task,
        "old_deadline": {"month": old_month, "day": old_event.get("day")},
        "new_deadline": {"month": new_month, "day": new_day, "year": target_year},
        "source": candidate.get("source"),
        "source_link": candidate.get("source_link"),
        "source_date": candidate.get("source_date"),
        "source_text": candidate.get("source_text"),
    })
    log["changes"] = log["changes"][-200:]
    save_json(CHANGE_LOG_FILE, log)

    return {
        "applied": True,
        "task": task,
        "old_month": old_month,
        "old_day": old_day,
        "new_month": new_month,
        "new_day": new_day,
    }

def main():
    now_iso = datetime.now(timezone.utc).isoformat()

    state = load_state()
    seen = set(state.get("seen", []))
    all_relevant = []

    for source in SOURCES:
        try:
            source_items = fetch_messages(source)
            all_relevant.extend(source_items)
            print(f"{source['name']}: {len(source_items)} relevant item(s)")
        except Exception as exc:
            print(f"WARNING: failed to fetch {source['name']}: {exc}", file=sys.stderr)

    current_ids = [m["id"] for m in all_relevant if m.get("id")]

    # Always refresh website data, even if nothing new appears.
    save_latest(all_relevant, now_iso)

    if not state.get("initialized"):
        save_state(current_ids, now_iso)
        if ALERT_FILE.exists():
            ALERT_FILE.unlink()
        print("Baseline created. latest-updates.json refreshed.")
        return

    new_items = [m for m in all_relevant if m["id"] not in seen]
    save_state(list(seen) + current_ids, now_iso)

    applied_changes = []
    review_items = []

    for item in new_items:
        candidate = candidate_from_notice(item)
        if not candidate:
            review_items.append(item)
            continue

        result = apply_deadline_change(candidate, now_iso)
        if result.get("applied"):
            applied_changes.append((item, result))
        else:
            review_items.append(item)

    if not new_items:
        if ALERT_FILE.exists():
            ALERT_FILE.unlink()
        print("No new relevant notices. latest-updates.json refreshed.")
        return

    lines = [
        "# هشدار پایش مواعید TPJ",
        "",
        "اطلاعیه‌های جدید زیر شناسایی شدند.",
        "",
    ]

    if applied_changes:
        lines += [
            "## تغییرات اعمال‌شده خودکار در تقویم",
            "",
        ]
        for item, result in applied_changes:
            lines.append(
                f"- {result['task']}: "
                f"{result['old_day'] or '?'} {result['old_month']} "
                f"→ {result['new_day']} {result['new_month']}"
            )
            if item.get("link"):
                lines.append(f"  - منبع: {item['link']}")
        lines.append("")

    if review_items:
        lines += [
            "## موارد نیازمند بررسی دستی",
            "",
            "این موارد در «آخرین تغییرات» نمایش داده می‌شوند، "
            "اما چون تاریخ/نوع تکلیف با اطمینان کافی تشخیص داده نشد، "
            "تقویم خودکار تغییر نکرد.",
            "",
        ]
        for item in review_items[-8:]:
            lines.append(f"### {item['source']}")
            if item["date"]:
                lines.append(f"- زمان انتشار: {item['date']}")
            if item["link"]:
                lines.append(f"- لینک: {item['link']}")
            lines.append(f"- متن: {item['text'][:1200]}")
            lines.append("")

    ALERT_FILE.write_text("\n".join(lines), encoding="utf-8")
    print(
        f"{len(new_items)} new notice(s); "
        f"{len(applied_changes)} auto-applied; "
        f"{len(review_items)} require review."
    )

if __name__ == "__main__":
    main()
