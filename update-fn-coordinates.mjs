import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULT_CONFIG = {
  mode: "challenges",
  codesFile: "caches.txt",
  dryRun: true,
  delaySeconds: 4,
  maxRetries: 3,
  headless: false,
  userDataDir: ".geocaching-browser-profile",
  logFile: "logs/fn-coordinate-updater.log",
  reportFile: "logs/fn-coordinate-report.txt",
  baseUrl: "https://coord.info",
  selectors: {
    publishedCoordinate: [
      "#uxLatLon",
      "[data-testid='coordinates']",
      ".coordinates",
      ".CoordInfoCode"
    ],
    waypointRows: [
      "#ctl00_ContentBody_Waypoints tr",
      "#ctl00_ContentBody_WaypointsGrid tr",
      "table tr"
    ],
    editCoordinates: [
      "a:has-text('Edit Coordinates')",
      "button:has-text('Edit Coordinates')",
      "a:has-text('Update Coordinates')",
      "button:has-text('Update Coordinates')",
      "a:has-text('Edit')"
    ],
    saveCoordinates: [
      "button:has-text('Save')",
      "input[type='submit'][value*='Save']",
      "button:has-text('Submit')",
      "input[type='submit'][value*='Submit']"
    ],
    acceptCoordinates: [
      "button:has-text('Accept')",
      "input[type='submit'][value*='Accept']",
      "button:has-text('OK')",
      "button:has-text('Ok')"
    ]
  }
};

const MODES = new Set(["challenges"]);
const COORD_RE = /\b([NS])\s*(\d{1,2})\s*(?:deg|\u00b0|\s)\s*(\d{1,2}(?:\.\d{1,5})?)['\u2032]?\s+([EW])\s*(\d{1,3})\s*(?:deg|\u00b0|\s)\s*(\d{1,2}(?:\.\d{1,5})?)['\u2032]?\b/i;
const TEMPORARY_ERROR_RE = /\b(429|500|502|503|504|timeout|temporar|network|navigation|net::|socket|econnreset)\b/i;

class UnexpectedPageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnexpectedPageError";
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--config") args.configFile = next();
    else if (arg === "--mode") args.mode = next();
    else if (arg === "--codes") args.codesFile = next();
    else if (arg === "--gpx") args.gpxFile = next();
    else if (arg === "--delay") args.delaySeconds = Number(next());
    else if (arg === "--retries") args.maxRetries = Number(next());
    else if (arg === "--log") args.logFile = next();
    else if (arg === "--report") args.reportFile = next();
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--live") args.dryRun = false;
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--headed") args.headless = false;
    else if (arg === "--login") args.loginOnly = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node update-fn-coordinates.mjs --dry-run
  node update-fn-coordinates.mjs --live

Options:
  --config config.json
  --mode challenges
  --codes caches.txt
  --gpx pocket-query.gpx
  --login
  --delay 4
  --retries 3
  --headless | --headed
  --log logs/fn-coordinate-updater.log
  --report logs/fn-coordinate-report.txt`);
}

async function loadConfig(args) {
  let fileConfig = {};
  const configFile = args.configFile ?? "config.json";
  try {
    fileConfig = JSON.parse(await fs.readFile(configFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" || args.configFile) throw error;
  }

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...args,
    selectors: {
      ...DEFAULT_CONFIG.selectors,
      ...(fileConfig.selectors ?? {}),
      ...(args.selectors ?? {})
    }
  };
}

function validateConfig(config) {
  if (!MODES.has(config.mode)) {
    throw new Error(`Unknown mode: ${config.mode}. Available modes: ${[...MODES].join(", ")}`);
  }
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

async function appendLog(config, message, data = undefined) {
  await ensureParentDir(config.logFile);
  const line = {
    time: new Date().toISOString(),
    message,
    ...(data === undefined ? {} : { data })
  };
  await fs.appendFile(config.logFile, `${JSON.stringify(line)}\n`);
}

async function readCodes(codesFile) {
  const text = await fs.readFile(codesFile, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().toUpperCase())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = line.match(/\bGC[A-Z0-9]+\b/);
      if (!match) throw new Error(`Invalid GC code line: ${line}`);
      return match[0];
    });
}

async function readCodesFromGpx(gpxFile) {
  const text = await fs.readFile(gpxFile, "utf8");
  const codes = new Set();
  for (const match of text.matchAll(/<name>\s*(GC[A-Z0-9]+)\s*<\/name>/gi)) {
    codes.add(match[1].toUpperCase());
  }
  if (codes.size) return [...codes];

  for (const match of text.matchAll(/\bGC[A-Z0-9]+\b/gi)) {
    codes.add(match[0].toUpperCase());
  }
  return [...codes];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCoordinate(text) {
  const match = text?.replace(/\s+/g, " ").match(COORD_RE);
  if (!match) return null;
  const coord = {
    latHem: match[1].toUpperCase(),
    latDeg: Number(match[2]),
    latMin: Number(match[3]),
    lonHem: match[4].toUpperCase(),
    lonDeg: Number(match[5]),
    lonMin: Number(match[6])
  };
  return {
    ...coord,
    key: `${coord.latHem}${coord.latDeg}:${coord.latMin.toFixed(3)} ${coord.lonHem}${coord.lonDeg}:${coord.lonMin.toFixed(3)}`,
    display: `${coord.latHem}${String(coord.latDeg).padStart(2, "0")} ${coord.latMin.toFixed(3).padStart(6, "0")} ${coord.lonHem}${String(coord.lonDeg).padStart(3, "0")} ${coord.lonMin.toFixed(3).padStart(6, "0")}`
  };
}

async function textFromFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const text = await locator.innerText().catch(() => "");
      if (parseCoordinate(text)) return text;
    }
  }
  return "";
}

async function findPublishedCoordinate(page, config) {
  const selectedText = await textFromFirst(page, config.selectors.publishedCoordinate);
  const selected = parseCoordinate(selectedText);
  if (selected) return selected;

  const bodyText = await page.locator("body").innerText();
  const match = bodyText.match(COORD_RE);
  return match ? parseCoordinate(match[0]) : null;
}

async function findFnWaypoint(page, config) {
  for (const selector of config.selectors.waypointRows) {
    const rows = await page.locator(selector).all();
    for (const row of rows) {
      const cells = await row.locator("th,td").allInnerTexts().catch(() => []);
      const rowText = cells.length ? cells.join(" ") : await row.innerText().catch(() => "");
      const normalized = rowText.replace(/\s+/g, " ").trim();
      const firstCell = cells[0]?.replace(/\s+/g, " ").trim().toUpperCase() ?? "";
      if (firstCell === "FN" || firstCell.startsWith("FN ") || /\bFN\b/i.test(normalized)) {
        const coord = parseCoordinate(normalized);
        if (coord) return { coord, text: normalized };
      }
    }
  }
  return null;
}

async function assertExpectedCachePage(page, code) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const isCachePage =
    /\/geocache\//i.test(url) ||
    /seek\/cache_details\.aspx/i.test(url) ||
    (new RegExp(`\\b${code}\\b`, "i").test(title) && /geocache|cache/i.test(title));

  const unexpected =
    /signin|login|account\/sign/i.test(url) ||
    /captcha|verify you are human|unusual traffic|automated requests|access denied|request blocked|temporarily blocked/i.test(body) ||
    (!isCachePage && /error|not found|page not found/i.test(title));

  if (unexpected) {
    throw new UnexpectedPageError(`Unexpected page for ${code}: ${url} (${title})`);
  }

  const loggedOut = await page
    .locator("a:has-text('Log In'), a:has-text('Log in'), button:has-text('Log In'), button:has-text('Log in')")
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  if (loggedOut) {
    throw new UnexpectedPageError(`Geocaching is showing a logged-out page for ${code}. Run --login first.`);
  }
}

async function handleCookieConsent(page, config, code) {
  const cookieButtons = [
    "button:has-text('Necessary cookies only')",
    "button:has-text('Allow all')",
    "button:has-text('Accept all')",
    "button:has-text('Accept All')"
  ];

  for (const selector of cookieButtons) {
    const button = page.locator(selector).first();
    if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
      await button.click();
      await appendLog(config, "dismissed cookie consent", { code, selector });
      await page.waitForTimeout(750);
      return true;
    }
  }
  return false;
}

async function clickFirstVisible(page, selectors, description) {
  for (const selector of selectors) {
    const matches = await page.locator(selector).all();
    for (const match of matches) {
      if (await match.isVisible().catch(() => false)) {
        await match.click();
        return selector;
      }
    }
  }
  throw new UnexpectedPageError(`Could not find ${description}`);
}

async function clickPublishedCoordinate(page, config) {
  for (const selector of config.selectors.publishedCoordinate) {
    const matches = await page.locator(selector).all();
    for (const match of matches) {
      if (!(await match.isVisible().catch(() => false))) continue;
      const text = await match.innerText().catch(() => "");
      if (parseCoordinate(text)) {
        await match.click();
        return selector;
      }
    }
  }

  const clicked = await page.evaluate((coordinatePattern) => {
    const re = new RegExp(coordinatePattern, "i");
    const elements = [...document.querySelectorAll("a,button,span,div,p,strong")];
    const candidate = elements.find((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const text = (el.textContent || "").replace(/\s+/g, " ");
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && re.test(text);
    });
    if (!candidate) return false;
    candidate.click();
    return true;
  }, String.raw`\b[NS]\s*\d{1,2}\s*(?:deg|\u00b0|\s)\s*\d{1,2}(?:\.\d{1,5})?['\u2032]?\s+[EW]\s*\d{1,3}\s*(?:deg|\u00b0|\s)\s*\d{1,2}(?:\.\d{1,5})?`);

  if (clicked) return "coordinate-text";

  throw new UnexpectedPageError("Could not click published coordinate");
}

async function visibleEditSurface(page) {
  const surfaces = [
    "[role='dialog']:visible",
    ".modal:visible",
    ".modal-dialog:visible",
    ".ui-dialog:visible",
    ".popover:visible",
    "[class*='modal']:visible",
    "[id*='modal']:visible",
    "[class*='dialog']:visible",
    "[id*='dialog']:visible"
  ];

  for (const selector of surfaces) {
    const surface = page.locator(selector).last();
    if (await surface.isVisible({ timeout: 500 }).catch(() => false)) return surface;
  }
  return page;
}

async function collectVisibleControls(page) {
  return page.evaluate(() => {
    const elements = [...document.querySelectorAll("a,button,input,summary,[role='button']")];
    return elements
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none") return null;
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || "").replace(/\s+/g, " ").trim().slice(0, 120),
          href: el.getAttribute("href") || "",
          title: el.getAttribute("title") || "",
          aria: el.getAttribute("aria-label") || "",
          id: el.id || "",
          className: typeof el.className === "string" ? el.className.slice(0, 120) : "",
          name: el.getAttribute("name") || "",
          type: el.getAttribute("type") || ""
        };
      })
      .filter(Boolean);
  });
}

async function fillCombinedCoordinateField(root, coord) {
  const inputs = await root.locator("input[type='text'], textarea").all();
  const candidates = [];
  for (const input of inputs) {
    if (!(await input.isVisible().catch(() => false))) continue;
    const value = await input.inputValue().catch(() => "");
    const labelText = await input.evaluate((el) => {
      const id = el.id;
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return `${label?.textContent ?? ""} ${el.getAttribute("name") ?? ""} ${el.getAttribute("placeholder") ?? ""} ${el.closest("tr,li,div,fieldset")?.textContent ?? ""}`.replace(/\s+/g, " ");
    });
    if (/solution|checker|note|log|search/i.test(labelText)) continue;
    candidates.push({ input, value, labelText });
    if (parseCoordinate(value) || /coord|lat|lon|lng|coordinate/i.test(labelText)) {
      await input.fill(coord.display);
      return true;
    }
  }

  if (candidates.length === 1) {
    await candidates[0].input.fill(coord.display);
    return true;
  }

  return false;
}

async function setSelectByTextOrValue(locator, value) {
  await locator.selectOption({ label: value }).catch(async () => {
    await locator.selectOption(value);
  });
}

async function fillSplitCoordinateFields(root, coord) {
  let visibleInputs = [];
  for (const input of await root.locator("input[type='text'], input[type='number']").all()) {
    if (await input.isVisible().catch(() => false)) visibleInputs.push(input);
  }
  let visibleSelects = [];
  for (const select of await root.locator("select").all()) {
    if (await select.isVisible().catch(() => false)) visibleSelects.push(select);
  }

  // Geocaching keeps other visible inputs on the cache page. Prefer fields whose
  // metadata looks like the coordinate editor when no dialog container is exposed.
  const fieldScore = async (locator) =>
    locator.evaluate((el) => {
      const text = [
        el.id,
        el.getAttribute("name"),
        el.getAttribute("aria-label"),
        el.getAttribute("placeholder"),
        el.closest("label")?.textContent,
        el.parentElement?.textContent,
        el.closest("tr,li,div,fieldset")?.textContent
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ");
      let score = 0;
      if (/coord|latitude|longitude|lat|lon|lng|degree|minute|hemisphere/i.test(text)) score += 10;
      if (/solution|checker|note|log|search/i.test(text)) score -= 20;
      return score;
    }).catch(() => 0);

  const scoredInputs = await Promise.all(visibleInputs.map(async (input, index) => ({ input, index, score: await fieldScore(input) })));
  const positiveInputs = scoredInputs.filter((item) => item.score > 0);
  if (positiveInputs.length >= 4) {
    visibleInputs = positiveInputs.sort((a, b) => a.index - b.index).map((item) => item.input);
  } else if (visibleInputs.length > 4) {
    visibleInputs = visibleInputs.slice(0, 4);
  }

  const scoredSelects = await Promise.all(visibleSelects.map(async (select, index) => ({ select, index, score: await fieldScore(select) })));
  const positiveSelects = scoredSelects.filter((item) => item.score > 0);
  if (positiveSelects.length >= 2) {
    visibleSelects = positiveSelects.sort((a, b) => a.index - b.index).map((item) => item.select);
  }

  if (visibleInputs.length < 4) return false;

  if (visibleSelects.length >= 2) {
    await setSelectByTextOrValue(visibleSelects[0], coord.latHem);
    await setSelectByTextOrValue(visibleSelects[1], coord.lonHem);
  }

  await visibleInputs[0].fill(String(coord.latDeg));
  await visibleInputs[1].fill(coord.latMin.toFixed(3));
  await visibleInputs[2].fill(String(coord.lonDeg));
  await visibleInputs[3].fill(coord.lonMin.toFixed(3));
  return true;
}

async function updateCoordinates(page, config, coord) {
  let editSelector = await clickPublishedCoordinate(page, config);
  await page.waitForTimeout(750);
  let editSurface = await visibleEditSurface(page);

  const formAppeared = await editSurface
    .locator("input[type='text'], input[type='number'], textarea, select")
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  if (!formAppeared) {
    await appendLog(config, "coordinate click did not open a recognizable form, trying edit selector fallback", {
      editSelector
    });
    try {
      editSelector = await clickFirstVisible(page, config.selectors.editCoordinates, "Edit Coordinates control");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(750);
      editSurface = await visibleEditSurface(page);
    } catch (error) {
      error.visibleControls = await collectVisibleControls(page).catch(() => []);
      throw error;
    }
  }

  let combined = await fillCombinedCoordinateField(editSurface, coord);
  let split = combined ? true : await fillSplitCoordinateFields(editSurface, coord);
  if (!split && editSurface !== page) {
    combined = await fillCombinedCoordinateField(page, coord);
    split = combined ? true : await fillSplitCoordinateFields(page, coord);
  }
  if (!split) {
    const error = new UnexpectedPageError("Could not find a recognized coordinate edit form");
    error.visibleControls = await collectVisibleControls(page).catch(() => []);
    throw error;
  }

  const saveSelector = await clickFirstVisible(editSurface, config.selectors.saveCoordinates, "Submit control");
  await page.waitForTimeout(750);

  try {
    const acceptSurface = await visibleEditSurface(page);
    const acceptSelector = await clickFirstVisible(acceptSurface, config.selectors.acceptCoordinates, "Accept control");
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    return { editSelector, saveSelector, acceptSelector };
  } catch (error) {
    error.visibleControls = await collectVisibleControls(page).catch(() => []);
    throw error;
  }
}

async function withRetry(config, code, action) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    try {
      if (attempt > 1) await appendLog(config, "retrying", { code, attempt });
      return await action(attempt);
    } catch (error) {
      lastError = error;
      if (error instanceof UnexpectedPageError || !TEMPORARY_ERROR_RE.test(error.message)) throw error;
      await appendLog(config, "temporary failure", { code, attempt, error: error.message });
      await sleep(1000 * attempt * attempt);
    }
  }
  throw lastError;
}

async function processCode(page, config, code) {
  return withRetry(config, code, async () => {
    const url = `${config.baseUrl.replace(/\/$/, "")}/${code}`;
    await appendLog(config, "opening cache", { code, url });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await handleCookieConsent(page, config, code);
    await assertExpectedCachePage(page, code);

    const published = await findPublishedCoordinate(page, config);
    if (!published) throw new UnexpectedPageError(`Could not find published coordinates for ${code}`);

    const fn = await findFnWaypoint(page, config);
    if (!fn) {
      return { code, status: "skipped", reason: "No FN waypoint", published };
    }

    if (published.key === fn.coord.key) {
      return { code, status: "skipped", reason: "FN equals published", published, fn: fn.coord };
    }

    if (config.dryRun) {
      return { code, status: "would-update", published, fn: fn.coord };
    }

    const selectors = await updateCoordinates(page, config, fn.coord);
    await appendLog(config, "updated coordinates", { code, selectors, fn: fn.coord.display });
    return { code, status: "updated", published, fn: fn.coord };
  });
}

function formatResult(result) {
  const lines = [result.code];
  if (result.reason === "No FN waypoint") {
    lines.push("  No FN waypoint", "  Skipped");
  } else if (result.reason === "FN equals published") {
    lines.push("  FN equals published", "  Skipped");
  } else {
    lines.push(`  Published: ${result.published.display}`);
    lines.push(`  FN:        ${result.fn.display}`);
    lines.push(`  ${result.status === "would-update" ? "Would update" : "Updated"}`);
  }
  return lines.join("\n");
}

async function saveUnexpectedPageArtifacts(page, config, code, error) {
  await ensureParentDir(config.logFile);
  const screenshot = path.join(path.dirname(config.logFile), `${code}-unexpected-page.png`);
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
  await appendLog(config, "stopped on unexpected page", {
    code,
    url: page.url(),
    error: error.message,
    screenshot
  });
}

async function runChallengesMode(page, config, codes) {
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    try {
      const result = await processCode(page, config, code);
      const block = formatResult(result);
      console.log(`${block}\n`);
      await fs.appendFile(config.reportFile, `${block}\n\n`);
    } catch (error) {
      if (error instanceof UnexpectedPageError) {
        if (error.visibleControls) {
          await appendLog(config, "visible controls on unexpected page", {
            code,
            controls: error.visibleControls
          });
        }
        await saveUnexpectedPageArtifacts(page, config, code, error);
        throw error;
      }
      await appendLog(config, "failed cache", { code, error: error.stack ?? error.message });
      throw error;
    }

    if (index < codes.length - 1) {
      await sleep(config.delaySeconds * 1000);
    }
  }
}

async function runMode(page, config, codes) {
  if (config.mode === "challenges") {
    await runChallengesMode(page, config, codes);
    return;
  }
  throw new Error(`No runner implemented for mode: ${config.mode}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = await loadConfig(args);
  validateConfig(config);
  const codes = config.loginOnly
    ? []
    : config.gpxFile
      ? await readCodesFromGpx(config.gpxFile)
      : await readCodes(config.codesFile);
  if (!config.loginOnly && !codes.length) throw new Error(`No GC codes found in ${config.codesFile}`);

  await ensureParentDir(config.reportFile);
  await fs.writeFile(config.reportFile, "");
  await appendLog(config, "starting run", {
    mode: config.mode,
    codes: codes.length,
    dryRun: config.dryRun,
    delaySeconds: config.delaySeconds,
    maxRetries: config.maxRetries
  });

  const browser = await chromium.launchPersistentContext(config.userDataDir, {
    headless: config.headless,
    viewport: { width: 1365, height: 900 }
  });
  const page = browser.pages()[0] ?? await browser.newPage();

  try {
    if (config.loginOnly) {
      await page.goto("https://www.geocaching.com/account/signin", { waitUntil: "domcontentloaded" });
      console.log("Log in in the browser window, then press Enter here to close and save the browser profile.");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      return;
    }

    await runMode(page, config, codes);
  } finally {
    await browser.close();
    await appendLog(config, "finished run");
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
