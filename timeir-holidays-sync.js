const fs = require("fs");
const puppeteer = require("puppeteer");

const OUT = "holidays.json";
const URL = "https://www.time.ir/event-year";
const MONTHS = [
  "فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور",
  "مهر","آبان","آذر","دی","بهمن","اسفند"
];

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUT, "utf8"));
  } catch {
    return { source: "Time.ir", source_url: URL, years: {} };
  }
}

function faToEn(s) {
  return String(s)
    .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
}

function normalizeMonth(s) {
  return s === "اَمرداد" ? "مرداد" : s;
}

async function selectYear(page, year) {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });

  // Find the year input by looking for a text input near the "به سال" label.
  const inputs = await page.$$('input[type="text"], input:not([type])');
  let input = null;

  for (const el of inputs) {
    const value = await page.evaluate(e => e.value || "", el);
    const placeholder = await page.evaluate(e => e.getAttribute("placeholder") || "", el);
    if (/^\d{4}$/.test(faToEn(value)) || placeholder.includes("سال")) {
      input = el;
      break;
    }
  }
  if (!input && inputs.length) input = inputs[0];
  if (!input) throw new Error("Year input not found on Time.ir");

  await input.click({ clickCount: 3 });
  await input.type(String(year), { delay: 40 });

  const clicked = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("button,input[type=submit],a")];
    const target = nodes.find(n => ((n.innerText || n.value || "").trim() === "برو"));
    if (target) { target.click(); return true; }
    return false;
  });

  if (!clicked) {
    await input.press("Enter");
  }

  await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
}

async function scrapeYear(page, year) {
  await selectYear(page, year);

  const actualYear = await page.evaluate(() => {
    const body = document.body.innerText || "";
    const m = body.match(/(?:فروردین|اردیبهشت|خرداد|تیر|اَمرداد|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s*\n?\s*([۰-۹0-9]{4})/);
    return m ? m[1] : null;
  });

  if (actualYear && Number(faToEn(actualYear)) !== Number(year)) {
    throw new Error(`Requested ${year} but page shows ${faToEn(actualYear)}`);
  }

  const raw = await page.evaluate(() => {
    // Current Time.ir marks official holiday events using "holiday" on the event item.
    const selectors = [
      "li.eventHoliday",
      "li.holiday",
      ".eventHoliday",
      "#ctl00_cphTop_Sampa_Web_View_EventUI_EventYearCalendar1247cphTop_3737_eventYearCalendar_eventYearCalendar li.holiday"
    ];
    const seen = new Set();
    const items = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (text && !seen.has(text)) {
          seen.add(text);
          items.push(text);
        }
      });
    }
    return items;
  });

  if (!raw.length) {
    // Debug snapshot to make failures diagnosable from Actions artifacts/logs.
    const html = await page.content();
    fs.writeFileSync(`timeir-debug-${year}.html`, html);
    await page.screenshot({ path: `timeir-debug-${year}.png`, fullPage: true });
    throw new Error(`No holiday elements found for ${year}`);
  }

  const months = Object.fromEntries(MONTHS.map(m => [m, []]));

  for (const text of raw) {
    const clean = faToEn(text);
    const match = clean.match(/^(\d{1,2})\s+(فروردین|اردیبهشت|خرداد|تیر|اَمرداد|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s+(.+)$/);
    if (!match) continue;

    const day = Number(match[1]);
    const month = normalizeMonth(match[2]);
    const title = match[3].trim();

    if (day >= 1 && day <= 31 && MONTHS.includes(month) && title) {
      months[month].push({ day, title, source: "Time.ir" });
    }
  }

  const count = Object.values(months).reduce((n, arr) => n + arr.length, 0);
  if (!count) throw new Error(`Holiday elements were found but none parsed for ${year}`);

  return { months, count };
}

(async () => {
  const data = loadExisting();
  data.years ||= {};

  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const current = Number(process.env.CURRENT_JALALI_YEAR || 1405);

  const start = manual ? Number(process.env.TIMEIR_START_YEAR || 1390) : current - 1;
  const end = manual ? Number(process.env.TIMEIR_END_YEAR || current + 2) : current + 2;

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
  );

  const updated = [];
  const skipped = [];

  for (let year = start; year <= end; year++) {
    try {
      const { months, count } = await scrapeYear(page, year);
      data.years[String(year)] = months;
      updated.push({ year, holidays: count });
      console.log(`${year}: ${count} official holiday event(s)`);
    } catch (err) {
      skipped.push({ year, reason: String(err) });
      console.log(`${year}: skipped - ${err}`);
    }
  }

  await browser.close();

  data.source = "Time.ir";
  data.source_url = URL;
  data.last_check_utc = new Date().toISOString();
  data.last_sync = { updated, skipped };

  fs.writeFileSync(OUT, JSON.stringify(data, null, 2), "utf8");

  if (!updated.length) {
    process.exitCode = 1;
    throw new Error("No year could be refreshed from Time.ir.");
  }
})();
