import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import net from "node:net";

const USER_AGENT =
  "Mozilla/5.0 (compatible; AI-SEO-App/1.0; +https://github.com/kenansalkanovic2003-sys/ai-seo-app)";
const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export function normalizeUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new Error("URL je obavezan.");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Podržani su samo http i https URL-ovi.");
  }
  return url;
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80")
  );
}

// Blocks requests to localhost / internal networks so the server can't be used to probe them.
async function assertPublicHost(url) {
  if (process.env.ALLOW_PRIVATE_HOSTS === "1") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("Interne adrese nisu dozvoljene.");
  }
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true }).catch(() => {
        throw new Error(`Domen "${host}" ne postoji ili nije dostupan.`);
      });
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Interne adrese nisu dozvoljene.");
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*", ...options.headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Follows redirects manually so every hop is checked against internal addresses.
async function fetchPage(startUrl) {
  let url = startUrl;
  const redirects = [];
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicHost(url);
    const started = Date.now();
    const res = await fetchWithTimeout(url, { redirect: "manual" });
    const responseTimeMs = Date.now() - started;
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      redirects.push({ from: url.href, to: new URL(location, url).href, status: res.status });
      url = new URL(location, url);
      continue;
    }
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_HTML_BYTES) throw new Error("Stranica je prevelika za analizu.");
    return {
      finalUrl: url,
      status: res.status,
      headers: Object.fromEntries(res.headers),
      html: new TextDecoder().decode(buffer),
      bytes: buffer.byteLength,
      responseTimeMs,
      redirects,
    };
  }
  throw new Error("Previše preusmjeravanja (redirect loop).");
}

async function fetchText(url) {
  try {
    await assertPublicHost(url);
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    return (await res.text()).slice(0, 20000);
  } catch {
    return null;
  }
}

function extract(html, baseUrl) {
  const $ = cheerio.load(html);
  const text = (sel) => $(sel).first().text().trim();
  const attr = (sel, name) => $(sel).first().attr(name)?.trim() || null;

  const headings = {};
  for (const level of [1, 2, 3, 4, 5, 6]) {
    headings[`h${level}`] = $(`h${level}`)
      .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);
  }

  const images = $("img")
    .map((_, el) => ({
      src: $(el).attr("src") || $(el).attr("data-src") || "",
      alt: $(el).attr("alt"),
      loading: $(el).attr("loading") || null,
      width: $(el).attr("width") || null,
      height: $(el).attr("height") || null,
    }))
    .get();

  const links = { internal: 0, external: 0, nofollow: 0, emptyAnchor: 0, samples: [] };
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
    let abs;
    try {
      abs = new URL(href, baseUrl);
    } catch {
      return;
    }
    const anchor = $(el).text().replace(/\s+/g, " ").trim();
    if (abs.hostname === baseUrl.hostname) links.internal++;
    else links.external++;
    if (/nofollow/i.test($(el).attr("rel") || "")) links.nofollow++;
    if (!anchor && !$(el).find("img[alt]").length && !$(el).attr("aria-label")) links.emptyAnchor++;
    if (links.samples.length < 40) links.samples.push({ href: abs.href, anchor });
  });

  const jsonLd = $('script[type="application/ld+json"]')
    .map((_, el) => {
      try {
        const data = JSON.parse($(el).contents().text());
        const items = Array.isArray(data) ? data : data["@graph"] || [data];
        return items.map((i) => i["@type"]).flat().filter(Boolean);
      } catch {
        return ["(neispravan JSON-LD)"];
      }
    })
    .get();

  const og = {};
  $('meta[property^="og:"]').each((_, el) => {
    og[$(el).attr("property")] = $(el).attr("content");
  });
  const twitter = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    twitter[$(el).attr("name")] = $(el).attr("content");
  });

  const hreflang = $('link[rel="alternate"][hreflang]')
    .map((_, el) => ({ lang: $(el).attr("hreflang"), href: $(el).attr("href") }))
    .get();

  $("script, style, noscript, svg, template").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const words = bodyText ? bodyText.split(" ").filter((w) => /\p{L}/u.test(w)) : [];

  return {
    title: text("title") || null,
    metaDescription: attr('meta[name="description"]', "content"),
    metaKeywords: attr('meta[name="keywords"]', "content"),
    metaRobots: attr('meta[name="robots"]', "content"),
    canonical: attr('link[rel="canonical"]', "href"),
    lang: attr("html", "lang"),
    viewport: attr('meta[name="viewport"]', "content"),
    charset: $("meta[charset]").length > 0 || /charset=/i.test(attr('meta[http-equiv="Content-Type"]', "content") || ""),
    favicon: attr('link[rel~="icon"]', "href"),
    headings,
    images: {
      total: images.length,
      missingAlt: images.filter((i) => i.alt === undefined).length,
      emptyAlt: images.filter((i) => i.alt === "").length,
      withoutDimensions: images.filter((i) => !i.width || !i.height).length,
      notLazy: images.filter((i) => i.loading !== "lazy").length,
      samplesMissingAlt: images.filter((i) => i.alt === undefined).slice(0, 10).map((i) => i.src),
    },
    links,
    structuredData: [...new Set(jsonLd)],
    openGraph: og,
    twitterCard: twitter,
    hreflang,
    wordCount: words.length,
    textExcerpt: bodyText.slice(0, 6000),
  };
}

function check(id, category, passed, severity, message) {
  return { id, category, passed, weight: severity, severity: passed ? "ok" : severity, message };
}

// Deterministic technical checks; the AI layer builds on top of these.
function runChecks(page, data, robotsTxt, sitemapFound) {
  const t = data.title || "";
  const d = data.metaDescription || "";
  const h1 = data.headings.h1;
  const checks = [
    check("https", "Tehnički", page.finalUrl.protocol === "https:", "critical", page.finalUrl.protocol === "https:" ? "Stranica koristi HTTPS." : "Stranica ne koristi HTTPS."),
    check("status", "Tehnički", page.status === 200, "critical", `HTTP status: ${page.status}.`),
    check("speed", "Performanse", page.responseTimeMs < 1500, "warning", `Vrijeme odziva servera: ${page.responseTimeMs} ms.`),
    check("size", "Performanse", page.bytes < 500 * 1024, "warning", `Veličina HTML-a: ${(page.bytes / 1024).toFixed(0)} KB.`),
    check("redirects", "Tehnički", page.redirects.length <= 1, "warning", `Broj preusmjeravanja: ${page.redirects.length}.`),
    check("title", "On-page", t.length >= 30 && t.length <= 60, t ? "warning" : "critical", t ? `Title ima ${t.length} znakova (preporuka 30–60).` : "Nedostaje <title> tag."),
    check("description", "On-page", d.length >= 120 && d.length <= 160, d ? "warning" : "critical", d ? `Meta description ima ${d.length} znakova (preporuka 120–160).` : "Nedostaje meta description."),
    check("h1", "On-page", h1.length === 1, h1.length ? "warning" : "critical", h1.length === 1 ? "Stranica ima tačno jedan H1." : `Broj H1 naslova: ${h1.length} (preporuka: tačno 1).`),
    check("h2", "On-page", data.headings.h2.length > 0, "info", `Broj H2 naslova: ${data.headings.h2.length}.`),
    check("content", "Sadržaj", data.wordCount >= 300, "warning", `Broj riječi: ${data.wordCount} (preporuka 300+).`),
    check("alt", "Pristupačnost", data.images.missingAlt === 0, "warning", data.images.missingAlt ? `${data.images.missingAlt} od ${data.images.total} slika nema alt atribut.` : "Sve slike imaju alt atribut."),
    check("canonical", "Tehnički", !!data.canonical, "warning", data.canonical ? `Canonical: ${data.canonical}` : "Nedostaje canonical link."),
    check("noindex", "Indeksiranje", !/noindex/i.test(data.metaRobots || "") && !/noindex/i.test(page.headers["x-robots-tag"] || ""), "critical", /noindex/i.test(data.metaRobots || "") ? "Stranica je označena kao noindex!" : "Stranica je dostupna za indeksiranje."),
    check("lang", "Tehnički", !!data.lang, "warning", data.lang ? `Jezik: ${data.lang}` : "Nedostaje lang atribut na <html>."),
    check("viewport", "Mobilno", !!data.viewport, "critical", data.viewport ? "Viewport meta tag postoji." : "Nedostaje viewport meta tag (mobilna prilagođenost)."),
    check("og", "Društvene mreže", !!(data.openGraph["og:title"] && data.openGraph["og:image"]), "info", data.openGraph["og:title"] ? "Open Graph tagovi postoje." : "Nedostaju Open Graph tagovi (og:title, og:image...)."),
    check("schema", "Strukturirani podaci", data.structuredData.length > 0, "warning", data.structuredData.length ? `Schema.org tipovi: ${data.structuredData.join(", ")}` : "Nema strukturiranih podataka (JSON-LD)."),
    check("robots", "Indeksiranje", !!robotsTxt, "info", robotsTxt ? "robots.txt postoji." : "robots.txt nije pronađen."),
    check("sitemap", "Indeksiranje", sitemapFound, "info", sitemapFound ? "XML sitemap pronađen." : "XML sitemap nije pronađen."),
    check("favicon", "Tehnički", !!data.favicon, "info", data.favicon ? "Favicon postoji." : "Nedostaje favicon."),
  ];

  const weights = { critical: 10, warning: 5, info: 2 };
  let max = 0;
  let lost = 0;
  for (const c of checks) {
    const w = weights[c.weight];
    max += w;
    if (!c.passed) lost += w;
  }
  const score = Math.max(0, Math.round(100 * (1 - lost / max)));
  return { checks, score };
}

export async function crawl(inputUrl) {
  const url = normalizeUrl(inputUrl);
  const page = await fetchPage(url);
  const contentType = page.headers["content-type"] || "";
  if (page.status >= 400 && !/html/i.test(contentType)) {
    throw new Error(`Stranica je vratila HTTP ${page.status}.`);
  }
  if (!/html/i.test(contentType)) {
    throw new Error(`URL ne vraća HTML stranicu (Content-Type: ${contentType || "nepoznat"}).`);
  }
  const data = extract(page.html, page.finalUrl);
  const origin = page.finalUrl.origin;
  const robotsTxt = await fetchText(new URL("/robots.txt", origin));
  const sitemapUrls = (robotsTxt?.match(/^sitemap:\s*(\S+)/gim) || []).map((l) => l.replace(/^sitemap:\s*/i, ""));
  let sitemapFound = sitemapUrls.length > 0;
  if (!sitemapFound) sitemapFound = !!(await fetchText(new URL("/sitemap.xml", origin)));

  const { checks, score } = runChecks(page, data, robotsTxt, sitemapFound);
  return {
    url: url.href,
    finalUrl: page.finalUrl.href,
    status: page.status,
    responseTimeMs: page.responseTimeMs,
    htmlSizeKb: Math.round(page.bytes / 1024),
    redirects: page.redirects,
    robotsTxt: robotsTxt ? robotsTxt.slice(0, 2000) : null,
    sitemapUrls,
    sitemapFound,
    data,
    checks,
    technicalScore: score,
  };
}
