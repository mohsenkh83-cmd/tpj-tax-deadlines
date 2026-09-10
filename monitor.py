"""TPJ monitor: Telegram sources plus ACCPress RSS. Requires requests, beautifulsoup4."""
import json
import re
import sys
import hashlib
import xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup

SOURCES = [
    {"name": "سازمان امور مالیاتی کشور", "url": "https://t.me/s/inta_press",
     "keywords": ["مهلت", "تمدید", "اظهارنامه", "ارزش افزوده", "بخشنامه", "مالیات", "عملکرد", "مواعید", "معاملات فصلی", "حقوق"]},
    {"name": "سازمان تأمین اجتماعی", "url": "https://t.me/s/tamin_media",
     "keywords": ["مهلت", "تمدید", "لیست", "حق بیمه", "بیمه", "کارفرما", "ارسال لیست", "پرداخت حق‌بیمه", "مواعید"]},
    {"name": "اک‌پرس ـ تازه‌های مالیاتی", "kind": "rss", "auto_apply": False,
     "url": "https://accpress.com/news/category/new-tax-affairs/",
     "feed_url": "https://accpress.com/news/category/new-tax-affairs/feed/",
     "keywords": ["مالیات", "مالیاتی", "مهلت", "تمدید", "اظهارنامه", "ارزش افزوده", "بخشنامه", "مودیان", "مؤدیان", "دفاتر", "تبصره", "معاملات فصلی"]},
]
STATE_FILE = Path("monitor-state.json")
ALERT_FILE = Path("alerts-new.md")
LATEST_FILE = Path("latest-updates.json")
DEADLINES_FILE = Path("deadlines.json")
CHANGE_LOG_FILE = Path("deadline-changes.json")
HEADERS = {"User-Agent": "Mozilla/5.0 TPJ-Tax-Deadline-Monitor/2.1"}
MONTHS = dict(zip("فروردین اردیبهشت خرداد تیر مرداد شهریور مهر آبان آذر دی بهمن اسفند".split(), range(1, 13)))
MONTH_NAMES = list(MONTHS)
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

def normalize(text):
    return re.sub(r"\s+", " ", text or "").strip()

def fa_to_en(s):
    return str(s).translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹", "0123456789"))

def en_to_fa(s):
    return str(s).translate(str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹"))

def matches_keywords(text, keywords):
    def clean(s):
        return normalize(s.replace("ي", "ی").replace("ك", "ک").replace("\u200c", " "))
    return any(clean(k) in clean(text) for k in keywords)

def get_response(url):
    response = requests.get(url, headers=HEADERS, timeout=30)
    response.raise_for_status()
    return response

def parse_feed(content, source):
    root = ET.fromstring(content)
    local = lambda tag: tag.rsplit("}", 1)[-1]
    if local(root.tag) not in ("rss", "feed", "RDF"):
        raise ValueError("Response is not an RSS/Atom feed")
    entries = [e for e in root.iter() if local(e.tag) in ("item", "entry")]
    messages = []
    for entry in entries[:40]:
        def field(*names):
            return next(("".join(c.itertext()).strip() for c in entry if local(c.tag) in names), "")
        title = BeautifulSoup(field("title"), "html.parser").get_text(" ", strip=True)
        summary = BeautifulSoup(field("description", "summary", "encoded", "content"), "html.parser").get_text(" ", strip=True)
        text = normalize(title + " — " + summary[:600])
        if not matches_keywords(text, source["keywords"]):
            continue
        link = field("link")
        if not link:
            link = next((c.get("href", "") for c in entry if local(c.tag) == "link" and c.get("rel", "alternate") == "alternate"), "")
        link = urljoin(source["url"], link)
        if urlparse(link).scheme not in ("http", "https") or urlparse(link).hostname not in ("accpress.com", "www.accpress.com"):
            continue
        raw_date = field("pubDate", "published", "date", "updated")
        dt = ""
        if raw_date:
            try:
                try:
                    parsed = parsedate_to_datetime(raw_date)
                except (ValueError, TypeError):
                    parsed = datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
                if parsed.tzinfo is not None:
                    dt = parsed.astimezone(timezone.utc).isoformat()
            except (ValueError, TypeError, OverflowError):
                pass
        messages.append({"source": source["name"], "id": "accpress:" + link,
                         "date": dt, "link": link, "text": text, "auto_apply": False})
    return messages[:20]

def fetch_rss(source):
    try:
        return parse_feed(get_response(source["feed_url"]).content, source)
    except (requests.RequestException, ET.ParseError, ValueError):
        # Discover an advertised category feed if its conventional URL changes.
        page = BeautifulSoup(get_response(source["url"]).content, "html.parser")
        candidates = page.select('link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]')
        for node in candidates:
            url = urljoin(source["url"], node.get("href", ""))
            if urlparse(url).hostname not in ("accpress.com", "www.accpress.com"):
                continue
            if "new-tax-affairs" not in url or url == source["feed_url"]:
                continue
            return parse_feed(get_response(url).content, source)
        raise ValueError("ACCPress category RSS unavailable; existing news retained")

def fetch_messages(source):
    if source.get("kind") == "rss":
        return fetch_rss(source)
    soup = BeautifulSoup(get_response(source["url"]).text, "html.parser")
    messages = []
    for wrap in soup.select(".tgme_widget_message_wrap"):
        post = wrap.select_one(".tgme_widget_message")
        text_el = wrap.select_one(".tgme_widget_message_text")
        if not post or not text_el:
            continue
        text = normalize(text_el.get_text(" ", strip=True))
        if not text or not matches_keywords(text, source["keywords"]):
            continue
        date_el = wrap.select_one("time")
        link_el = wrap.select_one("a.tgme_widget_message_date")
        link = link_el.get("href", "") if link_el else ""
        messages.append({"source": source["name"], "id": post.get("data-post") or link or text[:80],
                         "date": date_el.get("datetime", "") if date_el else "", "link": link,
                         "text": text, "auto_apply": source.get("auto_apply", True)})
    return messages[-20:]

def load_json(path, fallback):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return fallback

def save_json(path, payload):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)

def load_state():
    return load_json(STATE_FILE, {"initialized": False, "seen": []})

def detect_task(text):
    return next((canonical for canonical, clues in TASK_PATTERNS if all(c in text for c in clues)), None)

def detect_new_deadline(text):
    t = fa_to_en(text)
    months = "|".join(MONTHS)
    patterns = [rf"(?:تمدید(?:\s+شد)?|مهلت|تا\s+تاریخ|تا)\s*(?:تا\s*)?(\d{{1,2}})\s+({months})\s*(14\d{{2}})?",
                rf"(\d{{1,2}})\s+({months})\s*(14\d{{2}})?\s*(?:تمدید|مهلت)"]
    for pattern in patterns:
        m = re.search(pattern, t)
        if m and 1 <= int(m[1]) <= 31:
            return {"day": int(m[1]), "month": m[2], "year": int(m[3]) if m[3] else None}
    return None

def detect_period(text):
    periods = ["زمستان", "بهار", "تابستان", "پاییز", "اسفند"] + MONTH_NAMES[:-1]
    return " / ".join([p for p in periods if p in text][:3])

def candidate_from_notice(item):
    if not item.get("auto_apply", True):
        return None
    text = item.get("text", "")
    task, deadline = detect_task(text), detect_new_deadline(text)
    if not task or not deadline or ("تمدید" not in text and "مهلت" not in text):
        return None
    return {"task": task, "deadline": deadline, "period_hint": detect_period(text),
            "source": item.get("source", ""), "source_link": item.get("link", ""),
            "source_date": item.get("date", ""), "source_text": text}

def month_end_day(month_name, year):
    return 31 if MONTHS[month_name] <= 6 else 30 if MONTHS[month_name] <= 11 else 29

def normalize_day(day, month_name, year):
    if isinstance(day, int):
        return day
    if "پایان ماه" in str(day):
        return month_end_day(month_name, year)
    m = re.search(r"\d{1,2}", fa_to_en(day))
    return int(m[0]) if m else None

def main():
    now_iso = datetime.now(timezone.utc).isoformat()
    # Read strictly: never silently replace a malformed persisted review queue.
    state = json.loads(STATE_FILE.read_text(encoding="utf-8")) if STATE_FILE.exists() else {}
    review = state.setdefault("review", {})
    published = load_json(LATEST_FILE, {"items": []}).get("items", [])
    existing = {(i.get("link", ""), i.get("text", "")) for i in published}
    failures, added = [], 0
    for source in SOURCES:
        try:
            items = fetch_messages(source)
            print(f"{source['name']}: {len(items)} relevant item(s)")
        except Exception as exc:
            failures.append(source["name"])
            print(f"WARNING: {source['name']}: {exc}", file=sys.stderr)
            continue
        for item in items:
            identity = item.get("link") or item["id"]
            key = hashlib.sha256((identity + "\n" + item["text"]).encode()).hexdigest()
            if key in review:
                continue
            review[key] = {**item, "review_id": key,
                "status": "legacy_published" if (item.get("link", ""), item["text"]) in existing else "pending",
                "discovered_at": now_iso,
                "suggestion": {"task": detect_task(item["text"]), "deadline": detect_new_deadline(item["text"])}}
            if review[key]["status"] == "pending":
                added += 1
    if len(failures) == len(SOURCES):
        print("All sources failed; files unchanged.", file=sys.stderr)
        return 1
    state.update(initialized=True, review_version=1, last_check_utc=now_iso, failed_sources=failures)
    save_json(STATE_FILE, state)
    # Publication and calendar files are NEVER written by this monitor.
    print(f"{added} pending notice(s). Public news and calendar unchanged.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
