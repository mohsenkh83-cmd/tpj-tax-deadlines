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

async function openMonth(page, year, monthIndex) {
  await page.goto(URL, {waitUntil:"networkidle2", timeout:90000});

  const targetMonth = MONTHS[monthIndex];

  const result = await page.evaluate(({year,targetMonth,months}) => {
    const faToEn = s => String(s)
      .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
      .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

    const selects = [...document.querySelectorAll("select")];

    let monthSel = null;
    let yearSel = null;

    for (const sel of selects) {
      const texts = [...sel.options].map(o => (o.textContent||"").trim());
      const enTexts = texts.map(faToEn);

      if (!monthSel && months.some(m => texts.includes(m))) {
        monthSel = sel;
      }
      if (!yearSel && enTexts.includes(String(year))) {
        yearSel = sel;
      }
    }

    if (yearSel) {
      const opt = [...yearSel.options].find(o => faToEn((o.textContent||"").trim()) === String(year));
      if (opt) {
        yearSel.value = opt.value;
        yearSel.dispatchEvent(new Event("input",{bubbles:true}));
        yearSel.dispatchEvent(new Event("change",{bubbles:true}));
      }
    }

    if (monthSel) {
      const opt = [...monthSel.options].find(o => (o.textContent||"").trim() === targetMonth);
      if (opt) {
        monthSel.value = opt.value;
        monthSel.dispatchEvent(new Event("input",{bubbles:true}));
        monthSel.dispatchEvent(new Event("change",{bubbles:true}));
      }
    }

    // Some versions of the page use text/number inputs instead of selects.
    if (!yearSel) {
      for (const inp of document.querySelectorAll('input[type="text"],input[type="number"],input:not([type])')) {
        const meta = ((inp.placeholder||"")+" "+(inp.name||"")+" "+(inp.id||"")).toLowerCase();
        if (meta.includes("year") || meta.includes("سال")) {
          inp.value = String(year);
          inp.dispatchEvent(new Event("input",{bubbles:true}));
          inp.dispatchEvent(new Event("change",{bubbles:true}));
          break;
        }
      }
    }

    // Click a likely apply/go button when present.
    const candidates = [...document.querySelectorAll("button,input[type=submit],a")];
    const go = candidates.find(el =>
      /^(برو|نمایش|جستجو|اعمال|go)$/i.test(((el.innerText||el.value||"")+"").trim())
    );
    if (go) go.click();

    return {
      monthSelectorFound: !!monthSel,
      yearSelectorFound: !!yearSel
    };
  }, {year,targetMonth,months:MONTHS});

  await page.waitForNetworkIdle({idleTime:700, timeout:20000}).catch(()=>{});
  await new Promise(r=>setTimeout(r,900));

  // If changing selects didn't navigate, try URL/form-driven month switching
  // by clicking an option/link containing the target month.
  const visible = await page.evaluate(({year,targetMonth}) => {
    const txt = document.body.innerText || "";
    const faYear = String(year).replace(/\d/g,d=>"۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
    return txt.includes(targetMonth) && (txt.includes(String(year)) || txt.includes(faYear));
  }, {year,targetMonth});

  if (!visible) {
    const clicked = await page.evaluate((targetMonth) => {
      const nodes = [...document.querySelectorAll("a,button,option")];
      const n = nodes.find(el => ((el.textContent||"").trim() === targetMonth));
      if (n && n.tagName !== "OPTION") {
        n.click();
        return true;
      }
      return false;
    }, targetMonth);

    if (clicked) {
      await page.waitForNetworkIdle({idleTime:700, timeout:20000}).catch(()=>{});
      await new Promise(r=>setTimeout(r,900));
    }
  }

  return result;
}

async function scrapeVisibleMonth(page, year, monthIndex) {
  const targetMonth = MONTHS[monthIndex];

  const data = await page.evaluate(({targetMonth,months}) => {
    const norm = s => String(s||"").replace(/\s+/g," ").trim();
    const faToEn = s => String(s)
      .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
      .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

    const eventLines = [];
    const nodes = [...document.querySelectorAll("li,p,div,span")];

    for (const el of nodes) {
      const t = norm(el.innerText || el.textContent);
      if (!t || t.length > 280) continue;

      const m = faToEn(t).match(
        /(?:شنبه|یکشنبه|دوشنبه|سه‌شنبه|چهارشنبه|پنجشنبه|جمعه|آدینه)?\s*(\d{1,2})\s+(فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s+(.+)/
      );

      if (m && m[2] === targetMonth) {
        eventLines.push({
          day:Number(m[1]),
          month:m[2],
          title:norm(m[3]),
          className: typeof el.className === "string" ? el.className : "",
          style: el.getAttribute("style") || ""
        });
      }
    }

    const holidayDays = new Set();

    // 1) Explicit holiday class / semantics.
    const holidayNodes = [...document.querySelectorAll(
      '[class*="holiday" i],[class*="offday" i],[class*="off-day" i],[aria-label*="تعطیل"]'
    )];

    for (const el of holidayNodes) {
      let cur = el;
      for (let depth=0; depth<7 && cur; depth++, cur=cur.parentElement) {
        const txt = faToEn(norm(cur.innerText || cur.textContent));
        const m = txt.match(
          new RegExp("(?:^|\\\\s)(\\\\d{1,2})\\\\s+"+targetMonth+"(?:\\\\s|$)")
        );
        if (m) {
          holidayDays.add(Number(m[1]));
          break;
        }
      }

      const own = faToEn(norm(el.innerText || el.textContent));
      if (/^\d{1,2}$/.test(own)) {
        holidayDays.add(Number(own));
      }
    }

    // 2) Red text/date cells when class name isn't descriptive.
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      const color = cs.color || "";
      const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
      const looksRed =
        cls.includes("red") || cls.includes("danger") ||
        color === "rgb(255, 0, 0)" ||
        color === "rgb(220, 53, 69)" ||
        color === "rgb(204, 0, 0)";

      if (!looksRed) continue;

      const own = faToEn(norm(el.innerText || el.textContent));
      if (/^\d{1,2}$/.test(own)) {
        holidayDays.add(Number(own));
      }
    }

    return {
      eventLines,
      holidayDays:[...holidayDays]
    };
  }, {targetMonth,months:MONTHS});

  const out = [];
  const seen = new Set();

  // Prefer exact event titles for holiday-marked days.
  for (const e of data.eventLines) {
    if (!data.holidayDays.includes(e.day)) continue;
    const key = `${e.day}|${e.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({day:e.day,title:e.title,source:"Taghvim.com"});
    }
  }

  // Keep the date even if no event title was matched.
  for (const day of data.holidayDays) {
    if (!out.some(x => x.day === day)) {
      out.push({day,title:"تعطیل رسمی",source:"Taghvim.com"});
    }
  }

  out.sort((a,b)=>a.day-b.day);
  return out;
}

async function scrapeYear(page, year) {
  const monthsOut = Object.fromEntries(MONTHS.map(m => [m, []]));
  let count = 0;

  for (let monthIndex=0; monthIndex<12; monthIndex++) {
    const month = MONTHS[monthIndex];

    try {
      await openMonth(page, year, monthIndex);

      // Save debug snapshot for the first failed/empty month if needed.
      const visibleHeading = await page.evaluate(({month,year}) => {
        const body = document.body.innerText || "";
        const faYear = String(year).replace(/\d/g,d=>"۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
        return body.includes(month) && (body.includes(String(year)) || body.includes(faYear));
      }, {month,year});

      if (!visibleHeading) {
        console.log(`${year}/${month}: page did not visibly switch to requested month`);
      }

      const items = await scrapeVisibleMonth(page, year, monthIndex);
      monthsOut[month] = items;
      count += items.length;
      console.log(`${year}/${month}: ${items.length} holiday item(s)`);
    } catch (err) {
      console.log(`${year}/${month}: skipped - ${err}`);
      monthsOut[month] = [];
    }
  }

  if (!count) {
    await page.screenshot({path:`taghvim-debug-${year}.png`,fullPage:true});
    fs.writeFileSync(`taghvim-debug-${year}.html`,await page.content());
    throw new Error(`No holiday dates could be extracted for ${year}`);
  }

  return {months:monthsOut,count};
}

(async()=>{
  const existing = loadExisting();
  existing.years ||= {};

  const current = Number(process.env.CURRENT_JALALI_YEAR || 1405);
  const years = [current, current+1];

  const browser = await puppeteer.launch({
    headless:"new",
    args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
  });

  const page = await browser.newPage();
  await page.setViewport({width:1440,height:1200});
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
  );

  const updated=[], skipped=[];

  for (const year of years) {
    try {
      const {months,count}=await scrapeYear(page,year);

      // Only replace a year if we actually extracted data.
      if (count > 0) {
        existing.years[String(year)] = months;
        updated.push({year,holidays:count});
      }
    } catch(err) {
      skipped.push({year,reason:String(err)});
      console.log(`${year}: skipped - ${err}`);
    }
  }

  await browser.close();

  existing.source="Taghvim.com";
  existing.source_url=URL;
  existing.last_check_utc=new Date().toISOString();
  existing.last_sync={updated,skipped};

  fs.writeFileSync(OUT,JSON.stringify(existing,null,2),"utf8");

  if (!updated.length) {
    throw new Error("No year could be refreshed from Taghvim.com.");
  }
})();
