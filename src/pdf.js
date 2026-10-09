// Renders the report HTML (sent by the browser) to PDF with headless Chrome.
// The HTML comes from the client, so the page runs with JavaScript off and every
// network request blocked except Google Fonts; nothing in it can reach the server's network.
const ALLOWED_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const RENDER_TIMEOUT_MS = 20000;

let browserPromise = null;

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

// Tries, in order: PUPPETEER_EXECUTABLE_PATH, a browser downloaded by puppeteer,
// the Chrome installed on this computer, then Microsoft Edge (also Chromium).
function launchCandidates() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return [{ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }];
  return [{}, { channel: "chrome" }, ...EDGE_PATHS.map((executablePath) => ({ executablePath }))];
}

async function launchBrowser() {
  const { default: puppeteer } = await import("puppeteer");
  const errors = [];
  for (const candidate of launchCandidates()) {
    try {
      return await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        ...candidate,
      });
    } catch (err) {
      errors.push(err.message.split("\n")[0]);
    }
  }
  throw new Error(
    process.env.PUPPETEER_EXECUTABLE_PATH ? errors[0] : "na računaru nije pronađen ni Google Chrome ni Microsoft Edge",
  );
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchBrowser();
    browserPromise.catch(() => (browserPromise = null));
  }
  const browser = await browserPromise;
  if (!browser.connected) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
}

export class PdfUnavailableError extends Error {}

export async function renderPdf(html, { footerLabel = "" } = {}) {
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    throw new PdfUnavailableError(
      `Chrome nije pronađen za izradu PDF-a (${err.message}). Instalirajte Google Chrome ili postavite PUPPETEER_EXECUTABLE_PATH na putanju do chrome.exe.`,
    );
  }
  const page = await browser.newPage();
  try {
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      if (url.startsWith("data:") || url === "about:blank") return req.continue();
      try {
        if (ALLOWED_HOSTS.has(new URL(url).hostname)) return req.continue();
      } catch {
        /* malformed URL: abort below */
      }
      req.abort();
    });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.setContent(html, { waitUntil: "networkidle0", timeout: RENDER_TIMEOUT_MS }).catch((err) => {
      // A slow font load shouldn't fail the export; render with what has loaded.
      if (err.name !== "TimeoutError") throw err;
    });
    const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "16mm", left: "12mm", right: "12mm" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="width:100%;font-size:8px;color:#5b6678;padding:0 12mm;display:flex;justify-content:space-between;font-family:sans-serif">
        <span>${escapeHtml(footerLabel)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closePdfBrowser() {
  if (browserPromise) (await browserPromise.catch(() => null))?.close();
}
