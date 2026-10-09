import * as cheerio from "cheerio";
import zlib from "node:zlib";
import {
  assertPublicHost,
  crawl,
  fetchText,
  fetchWithTimeout,
  normalizeUrl,
  parseRobotsSitemaps,
} from "./crawler.js";

export const MAX_PAGES_LIMIT = 200;
const MAX_SITEMAP_FILES = 20;
const MAX_SITEMAP_BYTES = 20 * 1024 * 1024;
const CONCURRENCY = 4;

const CHECK_LABELS = {
  https: "Stranica ne koristi HTTPS",
  status: "HTTP status nije 200",
  speed: "Spor odziv servera (>1,5 s)",
  size: "Prevelik HTML (>500 KB)",
  redirects: "Više od jednog preusmjeravanja",
  title: "Title nedostaje ili nije 30–60 znakova",
  description: "Meta description nedostaje ili nije 120–160 znakova",
  h1: "Nema tačno jedan H1",
  h2: "Nema H2 naslova",
  content: "Malo sadržaja (<300 riječi)",
  alt: "Slike bez alt atributa",
  canonical: "Nedostaje canonical link",
  noindex: "Stranica je noindex",
  lang: "Nedostaje lang atribut",
  viewport: "Nedostaje viewport meta tag",
  og: "Nedostaju Open Graph tagovi",
  schema: "Nema strukturiranih podataka (JSON-LD)",
  robots: "robots.txt nije pronađen",
  sitemap: "XML sitemap nije pronađen",
  favicon: "Nedostaje favicon",
};
// Site-level checks are reported once in the site summary, not per page.
const SITE_LEVEL_CHECKS = new Set(["robots", "sitemap"]);

async function fetchSitemapXml(url) {
  try {
    await assertPublicHost(url);
    const res = await fetchWithTimeout(url, { headers: { Accept: "application/xml,text/xml,*/*" } });
    if (!res.ok) return null;
    let buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_SITEMAP_BYTES) buf = buf.subarray(0, MAX_SITEMAP_BYTES);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    const text = buf.toString("utf8");
    return /<(urlset|sitemapindex)[\s>]/i.test(text) ? text : null;
  } catch {
    return null;
  }
}

// Walks sitemap indexes breadth-first and collects page URLs on the site's own host.
async function collectSitemapUrls(sitemapUrls, host, maxPages) {
  const queue = [...sitemapUrls];
  const seenSitemaps = new Set();
  const pages = new Set();
  const used = [];
  while (queue.length && seenSitemaps.size < MAX_SITEMAP_FILES && pages.size < maxPages) {
    const sm = queue.shift();
    if (seenSitemaps.has(sm)) continue;
    seenSitemaps.add(sm);
    let smUrl;
    try {
      smUrl = new URL(sm);
    } catch {
      continue;
    }
    const xml = await fetchSitemapXml(smUrl);
    if (!xml) continue;
    used.push(sm);
    const $ = cheerio.load(xml, { xml: true });
    $("sitemap > loc").each((_, el) => queue.push($(el).text().trim()));
    $("url > loc").each((_, el) => {
      if (pages.size >= maxPages) return false;
      try {
        const u = new URL($(el).text().trim());
        if (u.hostname.replace(/^www\./, "") === host.replace(/^www\./, "")) {
          u.hash = "";
          pages.add(u.href);
        }
      } catch {
        /* skip malformed <loc> */
      }
    });
  }
  return { pages: [...pages], sitemapsUsed: used };
}

// Fallback when a site has no sitemap: internal links found on the home page.
async function collectHomepageLinks(homeUrl, maxPages) {
  const html = await fetchText(homeUrl, 5 * 1024 * 1024);
  const pages = new Set([homeUrl.href]);
  if (!html) return [...pages];
  const $ = cheerio.load(html);
  $("a[href]").each((_, el) => {
    if (pages.size >= maxPages) return false;
    try {
      const u = new URL($(el).attr("href"), homeUrl);
      if (u.hostname !== homeUrl.hostname || !/^https?:$/.test(u.protocol)) return;
      if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|docx?|xlsx?|mp4|mp3)$/i.test(u.pathname)) return;
      u.hash = "";
      pages.add(u.href);
    } catch {
      /* skip malformed href */
    }
  });
  return [...pages];
}

// Minimal robots.txt matcher for the "*" group: longest matching rule wins, Allow wins ties.
function robotsMatcher(robotsTxt) {
  const rules = [];
  let applies = false;
  let inAgents = false;
  for (const raw of (robotsTxt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!inAgents) applies = false;
      inAgents = true;
      if (value === "*") applies = true;
      continue;
    }
    inAgents = false;
    if (applies && (key === "allow" || key === "disallow") && value) {
      const pattern = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
      rules.push({ allow: key === "allow", re: new RegExp(`^${pattern}`), len: value.length });
    }
  }
  return (url) => {
    const path = url.pathname + url.search;
    let best = null;
    for (const r of rules) {
      if (r.re.test(path) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
    }
    return !best || best.allow;
  };
}

function normalizeForCompare(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.href.replace(/\/$/, "");
  } catch {
    return u;
  }
}

function pageSummary(scan) {
  const d = scan.data;
  return {
    url: scan.url,
    finalUrl: scan.finalUrl,
    status: scan.status,
    score: scan.technicalScore,
    responseTimeMs: scan.responseTimeMs,
    title: d.title,
    description: d.metaDescription,
    h1: d.headings.h1,
    wordCount: d.wordCount,
    canonical: d.canonical ? new URL(d.canonical, scan.finalUrl).href : null,
    noindex: /noindex/i.test(d.metaRobots || ""),
    imagesMissingAlt: d.images.missingAlt,
    internalLinks: d.links.internal,
    structuredData: d.structuredData,
    failed: scan.checks
      .filter((c) => !c.passed && !SITE_LEVEL_CHECKS.has(c.id))
      .map(({ id, severity, message }) => ({ id, severity, message })),
  };
}

function groupDuplicates(pages, pick) {
  const groups = new Map();
  for (const p of pages) {
    const value = pick(p);
    if (!value) continue;
    const key = value.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { value: value.trim(), urls: [] });
    groups.get(key).urls.push(p.finalUrl);
  }
  return [...groups.values()].filter((g) => g.urls.length > 1).sort((a, b) => b.urls.length - a.urls.length);
}

export function summarizeSite(pages, errors, meta) {
  const ok = pages.filter((p) => p.status < 400);
  const issueMap = new Map();
  const sevRank = { critical: 0, warning: 1, info: 2 };
  // Error pages (4xx/5xx) are listed under httpErrors; their missing title etc. would only add noise here.
  for (const p of ok) {
    for (const f of p.failed) {
      if (!issueMap.has(f.id)) {
        issueMap.set(f.id, { id: f.id, label: CHECK_LABELS[f.id] || f.id, severity: f.severity, count: 0, urls: [] });
      }
      const issue = issueMap.get(f.id);
      if (sevRank[f.severity] < sevRank[issue.severity]) issue.severity = f.severity;
      issue.count++;
      if (issue.urls.length < 25) issue.urls.push(p.finalUrl);
    }
  }
  const issues = [...issueMap.values()].sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.count - a.count);

  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length) : 0);
  return {
    ...meta,
    pagesScanned: pages.length,
    pagesFailed: errors.length,
    averageScore: avg(ok.map((p) => p.score)),
    averageResponseMs: avg(pages.map((p) => p.responseTimeMs)),
    averageWordCount: avg(ok.map((p) => p.wordCount)),
    issues,
    duplicateTitles: groupDuplicates(ok, (p) => p.title),
    duplicateDescriptions: groupDuplicates(ok, (p) => p.description),
    duplicateH1: groupDuplicates(ok, (p) => p.h1[0]),
    httpErrors: [
      ...pages.filter((p) => p.status >= 400).map((p) => ({ url: p.finalUrl, error: `HTTP ${p.status}` })),
      ...errors,
    ],
    redirected: pages.filter((p) => normalizeForCompare(p.url) !== normalizeForCompare(p.finalUrl)).map((p) => ({ from: p.url, to: p.finalUrl })),
    canonicalElsewhere: ok
      .filter((p) => p.canonical && normalizeForCompare(p.canonical) !== normalizeForCompare(p.finalUrl))
      .map((p) => ({ url: p.finalUrl, canonical: p.canonical })),
    noindexPages: ok.filter((p) => p.noindex).map((p) => p.finalUrl),
    slowestPages: [...pages].sort((a, b) => b.responseTimeMs - a.responseTimeMs).slice(0, 5).map((p) => ({ url: p.finalUrl, ms: p.responseTimeMs })),
  };
}

async function runPool(items, worker, signal) {
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Scans a whole site from its sitemap. `onEvent` receives progress events:
 *   { type: "discovered", ... }  { type: "page", page }  { type: "pageError", url, error }  { type: "done", summary }
 */
export async function scanSite(inputUrl, { maxPages = 50, onEvent = () => {}, signal } = {}) {
  maxPages = Math.max(1, Math.min(MAX_PAGES_LIMIT, Number(maxPages) || 50));
  const start = normalizeUrl(inputUrl);
  await assertPublicHost(start);
  const origin = start.origin;

  const robotsTxt = await fetchText(new URL("/robots.txt", origin));
  const robotsSitemaps = parseRobotsSitemaps(robotsTxt);
  const candidates = robotsSitemaps.length
    ? robotsSitemaps
    : [new URL("/sitemap.xml", origin).href, new URL("/sitemap_index.xml", origin).href];

  let { pages: urls, sitemapsUsed } = await collectSitemapUrls(candidates, start.hostname, maxPages);
  const source = urls.length ? "sitemap" : "homepage";
  if (!urls.length) urls = await collectHomepageLinks(new URL("/", origin), maxPages);

  const allowed = robotsMatcher(robotsTxt);
  const blockedByRobots = urls.filter((u) => !allowed(new URL(u)));
  urls = urls.filter((u) => allowed(new URL(u)));

  const siteFiles = {
    robotsTxt,
    sitemapUrls: sitemapsUsed.length ? sitemapsUsed : robotsSitemaps,
    sitemapFound: sitemapsUsed.length > 0,
  };
  const meta = {
    origin,
    source,
    sitemapsUsed,
    robotsTxtFound: !!robotsTxt,
    sitemapFound: siteFiles.sitemapFound,
    blockedByRobots,
    limitedTo: maxPages,
  };
  onEvent({ type: "discovered", total: urls.length, ...meta });

  const pages = [];
  const errors = [];
  await runPool(
    urls,
    async (url) => {
      try {
        const page = pageSummary(await crawl(url, { siteFiles }));
        pages.push(page);
        onEvent({ type: "page", page, done: pages.length + errors.length, total: urls.length });
      } catch (err) {
        const error = err.name === "AbortError" ? "Timeout" : err.message === "fetch failed" ? "Nije moguće povezati se" : err.message;
        errors.push({ url, error });
        onEvent({ type: "pageError", url, error, done: pages.length + errors.length, total: urls.length });
      }
    },
    signal,
  );

  const summary = summarizeSite(pages, errors, meta);
  onEvent({ type: "done", summary, pages });
  return { summary, pages };
}
