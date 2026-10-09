import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { crawl } from "./crawler.js";
import { analyzeWithAI, analyzeSiteWithAI, hasApiKey, pagePrompt, sitePrompt } from "./ai.js";
import { scanSite, summarizeSite } from "./site.js";
import { renderPdf, PdfUnavailableError } from "./pdf.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const jsonBody = express.json({ limit: "2mb" });
// The PDF route carries a whole rendered report, so it gets its own larger limit.
app.use((req, res, next) => (req.path === "/api/pdf" ? next() : jsonBody(req, res, next)));
app.use(express.static(path.join(here, "..", "public")));

// Tells the UI whether AI runs through the API key or the free claude.ai copy/paste flow.
app.get("/api/config", (req, res) => {
  res.json({ apiKey: hasApiKey() });
});

// Prompts for the free flow: the user pastes them into claude.ai and pastes the JSON answer back.
app.post("/api/ai-prompt", (req, res) => {
  const scan = req.body?.scan;
  if (!scan?.data || !Array.isArray(scan.checks)) {
    return res.status(400).json({ error: "Nedostaju podaci skeniranja." });
  }
  res.json({ prompt: pagePrompt(scan, { language: req.body?.language || "bosanski" }) });
});

app.post("/api/site-ai-prompt", (req, res) => {
  const { summary, pages, language } = req.body || {};
  if (!summary || !Array.isArray(pages) || !pages.length) {
    return res.status(400).json({ error: "Nedostaju rezultati skeniranja sajta." });
  }
  res.json({ prompt: sitePrompt(summary, pages, { language: language || "bosanski" }) });
});

// Step 1: scan the page and run technical checks (fast, no AI cost).
app.post("/api/scan", async (req, res) => {
  try {
    res.json(await crawl(req.body?.url));
  } catch (err) {
    res.status(400).json({ error: friendlyError(err) });
  }
});

// Step 2: AI recommendations for a scan the client already has (avoids re-crawling).
app.post("/api/ai", async (req, res) => {
  const scan = req.body?.scan;
  if (!scan?.data || !Array.isArray(scan.checks)) {
    return res.status(400).json({ error: "Nedostaju podaci skeniranja." });
  }
  try {
    res.json(await analyzeWithAI(scan, { language: req.body?.language || "bosanski" }));
  } catch (err) {
    console.error(err);
    const status = err instanceof Anthropic.RateLimitError ? 429 : 502;
    res.status(status).json({ error: `AI analiza nije uspjela: ${friendlyError(err)}` });
  }
});

// One-shot API: scan + AI recommendations in a single call.
app.post("/api/analyze", async (req, res) => {
  let scan;
  try {
    scan = await crawl(req.body?.url);
  } catch (err) {
    return res.status(400).json({ error: friendlyError(err) });
  }
  try {
    const ai = await analyzeWithAI(scan, { language: req.body?.language || "bosanski" });
    res.json({ scan, ai });
  } catch (err) {
    console.error(err);
    const status = err instanceof Anthropic.RateLimitError ? 429 : 502;
    res.status(status).json({ scan, error: `AI analiza nije uspjela: ${friendlyError(err)}` });
  }
});

// Site-wide scan from the sitemap. Streams NDJSON progress events so the UI can show each page as it finishes.
app.post("/api/site-scan", async (req, res) => {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const send = (event) => {
    if (!res.writableEnded) res.write(JSON.stringify(event) + "\n");
  };
  try {
    await scanSite(req.body?.url, { maxPages: req.body?.maxPages, onEvent: send, signal: controller.signal });
  } catch (err) {
    send({ type: "error", error: friendlyError(err) });
  }
  res.end();
});

// Summary for a scan the user stopped early, built from the pages that finished.
app.post("/api/site-summary", (req, res) => {
  const { pages, errors, meta } = req.body || {};
  if (!Array.isArray(pages)) return res.status(400).json({ error: "Nedostaju stranice." });
  const m = meta || {};
  res.json(
    summarizeSite(pages, Array.isArray(errors) ? errors : [], {
      origin: m.origin ?? null,
      source: m.source ?? "sitemap",
      sitemapsUsed: m.sitemapsUsed ?? [],
      robotsTxtFound: !!m.robotsTxtFound,
      sitemapFound: !!m.sitemapFound,
      blockedByRobots: m.blockedByRobots ?? [],
      limitedTo: m.limitedTo ?? pages.length,
      stoppedEarly: true,
    }),
  );
});

app.post("/api/site-ai", async (req, res) => {
  const { summary, pages, language } = req.body || {};
  if (!summary || !Array.isArray(pages) || !pages.length) {
    return res.status(400).json({ error: "Nedostaju rezultati skeniranja sajta." });
  }
  try {
    res.json(await analyzeSiteWithAI(summary, pages, { language: language || "bosanski" }));
  } catch (err) {
    console.error(err);
    const status = err instanceof Anthropic.RateLimitError ? 429 : 502;
    res.status(status).json({ error: `AI analiza nije uspjela: ${friendlyError(err)}` });
  }
});

app.post("/api/pdf", express.json({ limit: "15mb" }), async (req, res) => {
  const { html, filename, footer } = req.body || {};
  if (typeof html !== "string" || !html.length) {
    return res.status(400).json({ error: "Nedostaje sadržaj izvještaja." });
  }
  try {
    const pdf = await renderPdf(html, { footerLabel: String(footer || "").slice(0, 200) });
    const safeName = String(filename || "seo-izvjestaj").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "seo-izvjestaj";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
    res.end(pdf);
  } catch (err) {
    console.error(err);
    const unavailable = err instanceof PdfUnavailableError;
    res.status(unavailable ? 501 : 500).json({ error: unavailable ? err.message : "Izrada PDF-a nije uspjela.", fallback: unavailable });
  }
});

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(err?.message || "")) return "Neispravan ili nedostaje ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.RateLimitError) return "Previše zahtjeva prema AI servisu, pokušajte za minutu.";
  if (err instanceof Anthropic.APIError) return err.message;
  if (err?.name === "AbortError") return "Stranica se nije učitala na vrijeme (timeout).";
  if (err?.code === "ERR_INVALID_URL" || err instanceof TypeError) {
    return err.message.includes("fetch failed") ? "Nije moguće povezati se sa stranicom." : "Neispravan URL.";
  }
  return err?.message || "Nepoznata greška.";
}

app.listen(PORT, () => {
  console.log(`AI SEO App radi na http://localhost:${PORT}`);
});
