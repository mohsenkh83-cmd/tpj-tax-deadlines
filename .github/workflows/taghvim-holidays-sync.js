const fs = require("fs");
const puppeteer = require("puppeteer");

const OUT = "holidays.json";
const URL = "https://www.taghvim.com/";
const MONTHS = [
  "فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور",
  "مهر","آبان","آذر","دی","بهمن","اسفند"
];

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUT, "utf8"));
  } catch {
    return { source: "Taghvim.com", source_url: URL, years: {} };
  }
}

function currentJalaliYear() {
  try {
    const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
      year: "numeric"
    }).formatToParts(new Date());
    const raw = parts.find(p => p.type === "year")?.value || "";
    const en = raw
      .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
      .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
    const y = Number(en);
    if (y) return y;
  } catch {}
  return 1405;
}

async function wait(ms) {
  await new Promise(r => setTimeout(r, ms));
}

async function eventHeading(page) {
  return await page.$eval("#events h1", el =>
    (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()
  ).catch(() => "");
}

async function clickMonthAndVerify(page, year, monthIndex) {
  const monthName = MONTHS[monthIndex];
  const selector = `a[data-month="${monthIndex + 1}"]`;

  const exists = await page.$(selector);
  if (!exists) {
    throw new Error(`Month button not found: ${selector}`);
  }

  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) throw new Error("month element missing");
    el.scrollIntoView({block:"center"});
    el.click();
  }, selector);

  // Taghvim updates #events by JS/AJAX. Wait until its heading REALLY becomes target month/year.
  const ok = await page.waitForFunction(
    ({monthName, year}) => {
      const h = document.querySelector("#events h1");
      if (!h) return false;
      const text = (h.innerText || h.textContent || "").replace(/\s+/g, " ").trim();

      const faYear = String(year).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
      return text.includes(monthName) &&
             (text.includes(String(year)) || text.includes(faYear));
    },
    {timeout: 15000, polling: 200},
    {monthName, year}
  ).then(() => true).catch(() => false);

  if (!ok) {
    const heading = await eventHeading(page);
    await page.screenshot({
      path:`taghvim-debug-${year}-${String(monthIndex+1).padStart(2,"0")}.png`,
      fullPage:true
    });
    fs.writeFileSync(
      `taghvim-debug-${year}-${String(monthIndex+1).padStart(2,"0")}.html`,
      await page.content(),
      "utf8"
    );
    throw new Error(
      `Clicked ${monthName}, but #events heading did not change. Current heading: ${heading}`
    );
  }

  await wait(350);
}

async function scrapeVisibleHolidays(page, monthName) {
  return await page.$$eval("#event_list li.is_holiday", (rows, monthName) => {
    const faToEn = s => String(s || "")
      .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
      .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

    const norm = s => String(s || "").replace(/\s+/g, " ").trim();

    return rows.map(li => {
      const full = norm(li.innerText || li.textContent);
      const bold = li.querySelector("b");
      const dateText = norm(bold ? (bold.innerText || bold.textContent) : full);
      const m = faToEn(dateText).match(/(\d{1,2})\s+(فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)/);

      if (!m || m[2] !== monthName) return null;

      let title = full;
      if (bold) {
        const prefix = norm(bold.innerText || bold.textContent);
        if (title.startsWith(prefix)) title = norm(title.slice(prefix.length));
      }

      return {
        day: Number(m[1]),
        title: title || "تعطیل رسمی",
        source: "Taghvim.com"
      };
    }).filter(Boolean);
  }, monthName);
}

async function scrapeCurrentYear(page, year) {
  const months = {};

  for (let i = 0; i < 12; i++) {
    const monthName = MONTHS[i];

    await clickMonthAndVerify(page, year, i);
    const items = await scrapeVisibleHolidays(page, monthName);

    // Deduplicate same holiday day/title.
    const seen = new Set();
    months[monthName] = items.filter(x => {
      const k = `${x.day}|${x.title}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    console.log(
      `${year}/${monthName}: verified, ${months[monthName].length} official holiday(s)`
    );
  }

  if (Object.keys(months).length !== 12) {
    throw new Error(`Only ${Object.keys(months).length}/12 months verified`);
  }

  return months;
}

(async () => {
  const year = currentJalaliYear();

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 1100});
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
  );

  await page.goto(URL, {
    waitUntil: "networkidle2",
    timeout: 90000
  });

  // The debug HTML proved these are the real month controls.
  await page.waitForSelector('a[data-month="1"]', {timeout:15000});
  await page.waitForSelector("#event_list", {timeout:15000});

  const months = await scrapeCurrentYear(page, year);

  await browser.close();

  const existing = loadExisting();
  existing.years ||= {};

  // Replace only after ALL 12 months succeeded.
  existing.years[String(year)] = months;
  existing.source = "Taghvim.com";
  existing.source_url = URL;
  existing.last_check_utc = new Date().toISOString();
  existing.last_sync = {
    year,
    verified_months: 12,
    status: "success"
  };

  fs.writeFileSync(
    OUT,
    JSON.stringify(existing, null, 2),
    "utf8"
  );

  console.log(`SUCCESS: ${year} holidays refreshed for all 12 months.`);
})().catch(err => {
  console.error("FAILED:", err);
  process.exit(1);
});
