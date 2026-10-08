import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { crawl } from "./crawler.js";
import { analyzeWithAI } from "./ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "..", "public")));

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
