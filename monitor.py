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

HEADERS = {
    "User-Agent": "Mozilla/5.0 TPJ-Tax-Deadline-Monitor/1.0"
}


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


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

    return messages[-12:]


def load_state():
    if not STATE_FILE.exists():
        return {"initialized": False, "seen": []}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"initialized": False, "seen": []}


def save_state(seen):
    payload = {
        "initialized": True,
        "last_check_utc": datetime.now(timezone.utc).isoformat(),
        "seen": sorted(set(seen))[-500:],
    }
    STATE_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main():
    state = load_state()
    seen = set(state.get("seen", []))
    all_relevant = []

    for source in SOURCES:
        try:
            all_relevant.extend(fetch_messages(source))
        except Exception as exc:
            print(f"WARNING: failed to fetch {source['name']}: {exc}", file=sys.stderr)

    current_ids = [m["id"] for m in all_relevant if m.get("id")]

    # اجرای اول فقط خط مبنا می‌سازد تا برای مطالب قدیمی هشدار کاذب ایجاد نشود.
    if not state.get("initialized"):
        save_state(current_ids)
        if ALERT_FILE.exists():
            ALERT_FILE.unlink()
        print("Baseline created. No alert on first run.")
        return

    new_items = [m for m in all_relevant if m["id"] not in seen]

    save_state(list(seen) + current_ids)

    if not new_items:
        if ALERT_FILE.exists():
            ALERT_FILE.unlink()
        print("No new relevant notices.")
        return

    lines = [
        "# هشدار پایش مواعید TPJ",
        "",
        "موارد زیر تازه در کانال‌های رسمیِ تحت پایش دیده شده‌اند.",
        "قبل از انتشار در سایت، متن و منبع رسمی بررسی و تأیید شود.",
        "",
    ]

    for item in new_items[-8:]:
        lines.append(f"## {item['source']}")
        if item["date"]:
            lines.append(f"- زمان انتشار: {item['date']}")
        if item["link"]:
            lines.append(f"- لینک: {item['link']}")
        lines.append(f"- متن: {item['text'][:1200]}")
        lines.append("")

    ALERT_FILE.write_text("\n".join(lines), encoding="utf-8")
    print(f"{len(new_items)} new relevant notice(s) detected.")


if __name__ == "__main__":
    main()
