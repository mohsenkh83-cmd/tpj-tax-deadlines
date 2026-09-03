const fs = require("fs");
const puppeteer = require("puppeteer");

const OUT = "holidays.json";
const URL = "https://www.taghvim.com/";
const MONTHS = [
  "فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور",
  "مهر","آبان","آذر","دی","بهمن","اسفند"
];

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(OUT, "utf8")); }
  catch { return { source: "Taghvim.com", source_url: URL, years: {} }; }
}
function faToEn(s) {
  return String(s)
    .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
}
function norm(s){ return String(s||"").replace(/\s+/g," ").trim(); }

async function chooseYear(page, year) {
  await page.goto(URL, {waitUntil:"networkidle2", timeout:90000});

  const result = await page.evaluate((targetYear) => {
    const faToEn = s => String(s)
      .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
      .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

    // 1) Prefer a SELECT containing the requested Jalali year.
    for (const sel of document.querySelectorAll("select")) {
      const opt = [...sel.options].find(o => faToEn(o.textContent).trim() === String(targetYear));
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change",{bubbles:true}));
        return {kind:"select", value:opt.value};
      }
    }

    // 2) Try a year-like text/number input.
    const inputs = [...document.querySelectorAll('input[type="text"],input[type="number"],input:not([type])')];
    for (const inp of inputs) {
      const meta = ((inp.placeholder||"")+" "+(inp.name||"")+" "+(inp.id||"")).toLowerCase();
      if (meta.includes("year") || meta.includes("سال")) {
        inp.focus();
        inp.value = String(targetYear);
        inp.dispatchEvent(new Event("input",{bubbles:true}));
        inp.dispatchEvent(new Event("change",{bubbles:true}));
        return {kind:"input"};
      }
    }
    return null;
  }, year);

  if (!result) throw new Error("Year selector not found");

  // Try clicking a likely submit/go button after changing year.
  await page.evaluate(() => {
    const candidates = [...document.querySelectorAll("button,input[type=submit],a")];
    const b = candidates.find(el => /^(برو|نمایش|جستجو|اعمال)$/i.test((el.innerText||el.value||"").trim()));
    if (b) b.click();
  });

  await page.waitForNetworkIdle({idleTime:700, timeout:20000}).catch(()=>{});
  await new Promise(r=>setTimeout(r,1200));
}

async function scrapeYear(page, year) {
  await chooseYear(page, year);

  // Validate that the requested year appears in visible page headings/content.
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  if (!bodyText.includes(String(year)) && !bodyText.includes(
      String(year).replace(/\d/g,d=>"۰۱۲۳۴۵۶۷۸۹"[Number(d)])
  )) {
    throw new Error(`Requested ${year} but requested year is not visible on page`);
  }

  const data = await page.evaluate((months) => {
    const norm = s => String(s||"").replace(/\s+/g," ").trim();
    const faToEn = s => String(s)
      .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
      .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

    // Collect event lines from visible "مناسبت های ..." sections.
    const eventLines = [];
    const allTextNodes = [...document.querySelectorAll("li, p, div")];
    for (const el of allTextNodes) {
      const t = norm(el.innerText || el.textContent);
      if (!t || t.length > 260) continue;
      const m = faToEn(t).match(/(?:شنبه|یکشنبه|دوشنبه|سه‌شنبه|چهارشنبه|پنجشنبه|جمعه)?\s*(\d{1,2})\s+(فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s+(.+)/);
      if (m) eventLines.push({day:Number(m[1]), month:m[2], title:norm(m[3])});
    }

    // Find holiday-marked date cells/items by class/style semantics.
    const holidayDates = [];
    const nodes = [...document.querySelectorAll("*")];
    for (const el of nodes) {
      const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
      const style = (el.getAttribute("style") || "").toLowerCase();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();

      const looksHoliday =
        cls.includes("holiday") || cls.includes("offday") || cls.includes("off-day") ||
        cls.includes("red") || cls.includes("danger") ||
        aria.includes("تعطیل") ||
        /color\s*:\s*(red|#f00|#ff0000|rgb\(255,\s*0,\s*0\))/i.test(style);

      if (!looksHoliday) continue;

      const t = faToEn(norm(el.innerText || el.textContent));
      if (!t || t.length > 120) continue;

      // Look for day+month together in the element or ancestors.
      let cur = el;
      for (let depth=0; depth<4 && cur; depth++, cur=cur.parentElement) {
        const txt = faToEn(norm(cur.innerText || cur.textContent));
        const mm = txt.match(/(?:^|\s)(\d{1,2})\s+(فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)(?:\s|$)/);
        if (mm) {
          holidayDates.push({day:Number(mm[1]), month:mm[2]});
          break;
        }
      }
    }

    // If holiday classes are on calendar cells containing only the day number,
    // correlate them with nearest month section heading.
    const holidayOnlyDayNodes = [...document.querySelectorAll('[class*="holiday" i],[class*="offday" i],[class*="off-day" i]')];
    for (const el of holidayOnlyDayNodes) {
      const t = faToEn(norm(el.innerText || el.textContent));
      if (!/^\d{1,2}$/.test(t)) continue;
      const day = Number(t);
      let cur = el;
      let month = null;
      for (let depth=0; depth<8 && cur; depth++, cur=cur.parentElement) {
        const txt = norm(cur.innerText || cur.textContent);
        month = months.find(m => txt.includes(m));
        if (month) break;
      }
      if (month) holidayDates.push({day, month});
    }

    return {eventLines, holidayDates};
  }, MONTHS);

  const holidayKeys = new Set(data.holidayDates.map(x => `${x.month}:${x.day}`));
  const monthsOut = Object.fromEntries(MONTHS.map(m => [m, []]));

  for (const e of data.eventLines) {
    if (!holidayKeys.has(`${e.month}:${e.day}`)) continue;
    if (!monthsOut[e.month].some(x => x.day===e.day && x.title===e.title)) {
      monthsOut[e.month].push({day:e.day, title:e.title, source:"Taghvim.com"});
    }
  }

  // If holiday dates were found but no title line matched, keep a neutral title
  // so the date is still correctly marked as a holiday.
  for (const h of data.holidayDates) {
    if (!monthsOut[h.month]) continue;
    if (!monthsOut[h.month].some(x => x.day===h.day)) {
      monthsOut[h.month].push({day:h.day, title:"تعطیل رسمی", source:"Taghvim.com"});
    }
  }

  for (const m of MONTHS) monthsOut[m].sort((a,b)=>a.day-b.day);

  const count = Object.values(monthsOut).reduce((n,a)=>n+a.length,0);
  if (!count) {
    await page.screenshot({path:`taghvim-debug-${year}.png`, fullPage:true});
    fs.writeFileSync(`taghvim-debug-${year}.html`, await page.content());
    throw new Error(`No holiday dates could be extracted for ${year}`);
  }

  return {months:monthsOut,count};
}

(async()=>{
  const existing = loadExisting();
  existing.years ||= {};

  const current = Number(process.env.CURRENT_JALALI_YEAR || 1405);
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";

  // Manual first run: current year and next year only.
  // Scheduled run: same range, preserving all already collected older years.
  const years = manual ? [current, current+1] : [current, current+1];

  const browser = await puppeteer.launch({
    headless:"new",
    args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  await page.setViewport({width:1440,height:1200});
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36");

  const updated=[], skipped=[];
  for (const year of years) {
    try {
      const {months,count} = await scrapeYear(page,year);
      existing.years[String(year)] = months;
      updated.push({year,holidays:count});
      console.log(`${year}: ${count} holiday record(s)`);
    } catch(err) {
      skipped.push({year,reason:String(err)});
      console.log(`${year}: skipped - ${err}`);
    }
  }
  await browser.close();

  existing.source = "Taghvim.com";
  existing.source_url = URL;
  existing.last_check_utc = new Date().toISOString();
  existing.last_sync = {updated,skipped};

  fs.writeFileSync(OUT, JSON.stringify(existing,null,2),"utf8");

  if (!updated.length) throw new Error("No year could be refreshed from Taghvim.com.");
})();
