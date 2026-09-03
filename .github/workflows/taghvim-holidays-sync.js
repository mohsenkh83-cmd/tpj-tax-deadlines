const fs = require("fs");
const puppeteer = require("puppeteer");

const OUT = "holidays.json";
const URL = "https://www.taghvim.com/";
const MONTHS = [
  "فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور",
  "مهر","آبان","آذر","دی","بهمن","اسفند"
];

function faToEn(s) {
  return String(s || "")
    .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
}

function enToFa(s) {
  return String(s).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUT, "utf8"));
  } catch {
    return { source: "Taghvim.com", source_url: URL, years: {} };
  }
}

async function wait(page, ms=900) {
  await new Promise(r => setTimeout(r, ms));
  await page.waitForNetworkIdle({ idleTime: 600, timeout: 12000 }).catch(() => {});
}

async function pageMatches(page, year, monthName) {
  return await page.evaluate(({year, monthName}) => {
    const text = (document.body.innerText || "").replace(/\s+/g, " ");
    const faYear = String(year).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
    const hasMonth = text.includes(monthName);
    const hasYear = text.includes(String(year)) || text.includes(faYear);

    const headings = [...document.querySelectorAll("h1,h2,h3,.title,.month-title")]
      .map(x => (x.innerText || x.textContent || "").replace(/\s+/g, " ").trim());

    const strongHeading = headings.some(t =>
      t.includes(monthName) && (t.includes(String(year)) || t.includes(faYear))
    );

    return hasMonth && hasYear && strongHeading;
  }, {year, monthName});
}

async function selectTargetMonth(page, year, monthIndex) {
  const monthName = MONTHS[monthIndex];
  const faYear = enToFa(year);

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await wait(page, 1000);

  // Most important fix:
  // Taghvim.com currently exposes one visible selector for the calendar period.
  // We search ALL select options for a combined "month + year" option first.
  const selected = await page.evaluate(({year, faYear, monthName, months}) => {
    function faToEn(s) {
      return String(s || "")
        .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
        .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
    }

    const selects = [...document.querySelectorAll("select")];

    // A) Combined month/year selector.
    for (const sel of selects) {
      const opts = [...sel.options];
      const opt = opts.find(o => {
        const t = (o.textContent || "").replace(/\s+/g, " ").trim();
        const en = faToEn(t);
        return t.includes(monthName) && en.includes(String(year));
      });

      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event("input", {bubbles:true}));
        sel.dispatchEvent(new Event("change", {bubbles:true}));

        if (sel.form) {
          const submit = sel.form.querySelector('button[type="submit"],input[type="submit"]');
          if (submit) submit.click();
        }
        return {mode:"combined", value:opt.value, text:opt.textContent};
      }
    }

    // B) Separate month/year selectors.
    let monthSel = null, yearSel = null;

    for (const sel of selects) {
      const texts = [...sel.options].map(o => (o.textContent || "").trim());
      const enTexts = texts.map(faToEn);

      if (!monthSel && texts.some(t => months.includes(t))) monthSel = sel;
      if (!yearSel && enTexts.some(t => t === String(year))) yearSel = sel;
    }

    if (yearSel) {
      const opt = [...yearSel.options].find(o => faToEn((o.textContent || "").trim()) === String(year));
      if (opt) {
        yearSel.value = opt.value;
        yearSel.dispatchEvent(new Event("input", {bubbles:true}));
        yearSel.dispatchEvent(new Event("change", {bubbles:true}));
      }
    }

    if (monthSel) {
      const opt = [...monthSel.options].find(o => (o.textContent || "").trim() === monthName);
      if (opt) {
        monthSel.value = opt.value;
        monthSel.dispatchEvent(new Event("input", {bubbles:true}));
        monthSel.dispatchEvent(new Event("change", {bubbles:true}));
      }
    }

    if (monthSel || yearSel) {
      const form = (monthSel && monthSel.form) || (yearSel && yearSel.form);
      if (form) {
        const submit = form.querySelector('button[type="submit"],input[type="submit"]');
        if (submit) submit.click();
      }
      return {mode:"separate", month:!!monthSel, year:!!yearSel};
    }

    // C) Fallback: links/buttons whose text contains target month and year.
    const nodes = [...document.querySelectorAll("a,button")];
    const node = nodes.find(el => {
      const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      const en = faToEn(t);
      return t.includes(monthName) && en.includes(String(year));
    });

    if (node) {
      node.click();
      return {mode:"click", text:node.textContent};
    }

    return {mode:"not-found"};
  }, {year, faYear, monthName, months:MONTHS});

  await wait(page, 1200);

  if (await pageMatches(page, year, monthName)) {
    return selected;
  }

  // Last fallback: use keyboard navigation on the first visible select.
  const fallback = await page.evaluate(({year, monthName}) => {
    function faToEn(s) {
      return String(s || "")
        .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
        .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
    }

    const sels = [...document.querySelectorAll("select")]
      .filter(s => s.offsetParent !== null);

    for (const sel of sels) {
      const opts = [...sel.options];
      const idx = opts.findIndex(o => {
        const t = (o.textContent || "").replace(/\s+/g, " ").trim();
        return t.includes(monthName) && faToEn(t).includes(String(year));
      });
      if (idx >= 0) {
        sel.selectedIndex = idx;
        sel.dispatchEvent(new Event("input",{bubbles:true}));
        sel.dispatchEvent(new Event("change",{bubbles:true}));
        return true;
      }
    }
    return false;
  }, {year, monthName});

  if (fallback) await wait(page, 1200);

  if (!(await pageMatches(page, year, monthName))) {
    await page.screenshot({
      path:`taghvim-debug-${year}-${String(monthIndex+1).padStart(2,"0")}.png`,
      fullPage:true
    });
    fs.writeFileSync(
      `taghvim-debug-${year}-${String(monthIndex+1).padStart(2,"0")}.html`,
      await page.content(),
      "utf8"
    );
    throw new Error(`Requested ${monthName} ${year}, but page did not switch to that month.`);
  }

  return selected;
}

async function scrapeCurrentMonth(page, year, monthIndex) {
  const monthName = MONTHS[monthIndex];

  const result = await page.evaluate(({monthName}) => {
    function faToEn(s) {
      return String(s || "")
        .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
        .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
    }
    function norm(s) {
      return String(s || "").replace(/\s+/g, " ").trim();
    }

    const events = [];
    const holidayDays = new Set();

    // Taghvim lists monthly occasions under a heading such as:
    // "مناسبت های شهریور ۱۴۰۵"
    const all = [...document.querySelectorAll("li,p,div,span,a")];

    for (const el of all) {
      const text = norm(el.innerText || el.textContent);
      if (!text || text.length > 260) continue;

      const en = faToEn(text);
      const m = en.match(
        /(?:شنبه|یکشنبه|دوشنبه|سه‌شنبه|چهارشنبه|پنجشنبه|جمعه|آدینه)?\s*(\d{1,2})\s+(فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s+(.+)/
      );

      if (m && m[2] === monthName) {
        const day = Number(m[1]);
        const title = norm(m[3]);

        const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
        const style = getComputedStyle(el);
        const color = style.color || "";

        const explicitlyHoliday =
          cls.includes("holiday") ||
          cls.includes("offday") ||
          cls.includes("off-day") ||
          cls.includes("red") ||
          el.getAttribute("aria-label")?.includes("تعطیل") ||
          /تعطیل رسمی|تعطیل است/.test(text) ||
          color === "rgb(255, 0, 0)" ||
          color === "rgb(204, 0, 0)" ||
          color === "rgb(220, 53, 69)";

        events.push({day, title, explicitlyHoliday});
        if (explicitlyHoliday) holidayDays.add(day);
      }
    }

    // Calendar cells: detect explicit holiday/red styling.
    const candidates = [...document.querySelectorAll(
      'td,li,button,a,span,div,[class*="day" i],[class*="date" i]'
    )];

    for (const el of candidates) {
      const own = faToEn(norm(el.innerText || el.textContent));
      if (!/^\d{1,2}$/.test(own)) continue;

      const day = Number(own);
      if (day < 1 || day > 31) continue;

      const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
      const cs = getComputedStyle(el);
      const color = cs.color || "";
      const bg = cs.backgroundColor || "";
      const aria = el.getAttribute("aria-label") || "";

      const holiday =
        cls.includes("holiday") ||
        cls.includes("offday") ||
        cls.includes("off-day") ||
        cls.includes("red") ||
        aria.includes("تعطیل") ||
        color === "rgb(255, 0, 0)" ||
        color === "rgb(204, 0, 0)" ||
        color === "rgb(220, 53, 69)" ||
        bg === "rgb(255, 0, 0)";

      if (holiday) holidayDays.add(day);
    }

    return {events, holidayDays:[...holidayDays]};
  }, {monthName});

  const output = [];
  const seenDays = new Set();

  for (const day of result.holidayDays.sort((a,b)=>a-b)) {
    const event = result.events.find(e => e.day === day && e.title);
    output.push({
      day,
      title: event ? event.title : "تعطیل رسمی",
      source: "Taghvim.com"
    });
    seenDays.add(day);
  }

  return output;
}

async function scrapeYear(page, year) {
  const months = {};
  const status = [];

  for (let m=0; m<12; m++) {
    const monthName = MONTHS[m];
    const nav = await selectTargetMonth(page, year, m);
    const items = await scrapeCurrentMonth(page, year, m);

    months[monthName] = items;
    status.push({
      month: monthName,
      navigation: nav.mode || "unknown",
      holidays: items.length
    });

    console.log(
      `${year}/${monthName}: page verified, ${items.length} official holiday(s), navigation=${nav.mode}`
    );
  }

  // Critical safeguard: all 12 months MUST have been verified.
  if (Object.keys(months).length !== 12) {
    throw new Error(`Only ${Object.keys(months).length}/12 months were verified for ${year}`);
  }

  return {months, status};
}

(async () => {
  const current = Number(process.env.CURRENT_JALALI_YEAR || 1405);
  const yearsToRefresh = [current, current + 1];

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({width:1440, height:1100});
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
  );

  const existing = loadExisting();
  existing.years ||= {};

  const refreshed = [];
  const failed = [];

  for (const year of yearsToRefresh) {
    try {
      const {months, status} = await scrapeYear(page, year);

      // Do not partially replace a year.
      existing.years[String(year)] = months;
      refreshed.push({year, months:12, status});
    } catch (err) {
      failed.push({year, error:String(err)});
      console.error(`${year}: FAILED:`, err);
    }
  }

  await browser.close();

  existing.source = "Taghvim.com";
  existing.source_url = URL;
  existing.last_check_utc = new Date().toISOString();
  existing.last_sync = {refreshed, failed};

  fs.writeFileSync(
    OUT,
    JSON.stringify(existing, null, 2),
    "utf8"
  );

  // Workflow must fail if current year was not completely refreshed.
  if (!refreshed.some(x => x.year === current && x.months === 12)) {
    throw new Error(
      `Current Jalali year ${current} was NOT fully refreshed. ` +
      `Existing holidays.json was preserved for failed years.`
    );
  }

  console.log(`SUCCESS: ${current} was verified month-by-month (12/12).`);
})();
