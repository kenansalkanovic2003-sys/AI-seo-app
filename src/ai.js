import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const client = new Anthropic();

const SYSTEM_PROMPT = `Ti si iskusan SEO stručnjak (tehnički SEO, on-page SEO, sadržaj, strukturirani podaci, Core Web Vitals, lokalni SEO).
Dobit ćeš podatke prikupljene skeniranjem jedne web stranice ili cijelog sajta i rezultate automatskih tehničkih provjera.
Tvoj zadatak je napraviti konkretan, provedljiv SEO plan optimizacije.

Pravila:
- Piši na jeziku koji korisnik zatraži (polje "language"); tehnički termini mogu ostati na engleskom.
- Budi konkretan: umjesto "poboljšaj title" napiši tačan novi title. Prijedlozi za title, meta description i H1 moraju biti na jeziku sadržaja stranice.
- Oslanjaj se samo na dostavljene podatke. Ako nešto nije moguće utvrditi iz podataka (npr. backlinkovi, stvarni Core Web Vitals), reci to umjesto da izmišljaš.
- Prioritete poredaj po uticaju na rangiranje i lakoći implementacije.
- Gdje ima smisla, daj gotov kod (HTML tagove, JSON-LD) koji se može kopirati.`;

const issueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["priority", "category", "problem", "why", "fix"],
  properties: {
    priority: { type: "string", enum: ["visok", "srednji", "nizak"] },
    category: { type: "string" },
    problem: { type: "string" },
    why: { type: "string", description: "Zašto je ovo važno za SEO" },
    fix: { type: "string", description: "Tačni koraci ili kod za rješenje" },
  },
};

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "score",
    "summary",
    "detectedTopic",
    "targetKeywords",
    "issues",
    "optimizedTitle",
    "optimizedMetaDescription",
    "optimizedH1",
    "headingStructure",
    "contentRecommendations",
    "structuredDataSuggestion",
    "quickWins",
  ],
  properties: {
    score: { type: "integer", description: "Ukupna SEO ocjena 0-100" },
    summary: { type: "string" },
    detectedTopic: { type: "string", description: "O čemu je stranica i ko je ciljna publika" },
    targetKeywords: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["keyword", "intent", "presentOnPage"],
        properties: {
          keyword: { type: "string" },
          intent: { type: "string", enum: ["informativna", "komercijalna", "transakcijska", "navigacijska"] },
          presentOnPage: { type: "boolean" },
        },
      },
    },
    issues: { type: "array", items: issueSchema },
    optimizedTitle: { type: "string" },
    optimizedMetaDescription: { type: "string" },
    optimizedH1: { type: "string" },
    headingStructure: { type: "array", items: { type: "string" }, description: "Predložena struktura H2/H3 naslova" },
    contentRecommendations: { type: "array", items: { type: "string" } },
    structuredDataSuggestion: { type: "string", description: "Gotov JSON-LD <script> blok prilagođen stranici" },
    quickWins: { type: "array", items: { type: "string" }, description: "3-5 izmjena koje se mogu uraditi odmah" },
  },
};

// True when the server can call the Claude API itself; otherwise the UI offers the free claude.ai flow.
export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function pageRequest(crawlResult, language) {
  const { data, ...meta } = crawlResult;
  const payload = {
    language,
    page: {
      url: meta.finalUrl,
      status: meta.status,
      responseTimeMs: meta.responseTimeMs,
      htmlSizeKb: meta.htmlSizeKb,
      redirects: meta.redirects,
      sitemapFound: meta.sitemapFound,
      robotsTxt: meta.robotsTxt,
      ...data,
    },
    automatedChecks: meta.checks.map(({ weight, ...c }) => c),
    technicalScore: meta.technicalScore,
  };

  return {
    schema: REPORT_SCHEMA,
    content: `Analiziraj SEO ove stranice i napravi plan optimizacije. Odgovori na jeziku: ${language}.\n\n<scan_data>\n${JSON.stringify(payload, null, 2)}\n</scan_data>`,
  };
}

export async function analyzeWithAI(crawlResult, { language = "bosanski" } = {}) {
  return callClaude(pageRequest(crawlResult, language));
}

const SITE_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "summary", "siteTopic", "sitewideIssues", "pagePriorities", "contentStrategy", "internalLinking", "quickWins"],
  properties: {
    score: { type: "integer", description: "Ukupna SEO ocjena sajta 0-100" },
    summary: { type: "string" },
    siteTopic: { type: "string", description: "O čemu je sajt i ko je ciljna publika" },
    sitewideIssues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "problem", "affectedPages", "fix"],
        properties: {
          priority: { type: "string", enum: ["visok", "srednji", "nizak"] },
          problem: { type: "string" },
          affectedPages: { type: "integer" },
          fix: { type: "string", description: "Kako riješiti na nivou cijelog sajta (npr. u šablonu/CMS-u)" },
        },
      },
    },
    pagePriorities: {
      type: "array",
      description: "Stranice koje prve treba popraviti",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "reason", "actions"],
        properties: {
          url: { type: "string" },
          reason: { type: "string" },
          actions: { type: "array", items: { type: "string" } },
        },
      },
    },
    contentStrategy: { type: "array", items: { type: "string" }, description: "Kanibalizacija ključnih riječi, praznine u sadržaju, nove stranice" },
    internalLinking: { type: "array", items: { type: "string" } },
    quickWins: { type: "array", items: { type: "string" } },
  },
};

function siteRequest(summary, pages, language) {
  const payload = {
    language,
    site: summary,
    pages: pages.map((p) => ({
      url: p.finalUrl,
      status: p.status,
      score: p.score,
      title: p.title,
      description: p.description,
      h1: p.h1,
      words: p.wordCount,
      ms: p.responseTimeMs,
      schema: p.structuredData,
      failed: p.failed.map((f) => f.id),
    })),
  };
  return {
    schema: SITE_REPORT_SCHEMA,
    content: `Ovo su rezultati skeniranja cijelog sajta (stranice iz sitemapa). Napravi SEO plan za cijeli sajt: probleme koji se ponavljaju na mnogo stranica (i kako ih riješiti jednom, u šablonu), stranice koje prve treba popraviti, dupli sadržaj i kanibalizaciju ključnih riječi, interno linkovanje i strategiju sadržaja. Odgovori na jeziku: ${language}.\n\n<site_scan>\n${JSON.stringify(payload)}\n</site_scan>`,
  };
}

export async function analyzeSiteWithAI(summary, pages, { language = "bosanski" } = {}) {
  return callClaude(siteRequest(summary, pages, language));
}

// Free alternative to the API: one self-contained prompt the user pastes into claude.ai
// (covered by their Claude subscription), then pastes the JSON answer back into the app.
function manualPrompt({ schema, content }) {
  return `${SYSTEM_PROMPT}

${content}

FORMAT ODGOVORA:
Odgovori isključivo jednim JSON objektom unutar \`\`\`json bloka, bez ikakvog teksta prije ili poslije njega.
JSON mora tačno odgovarati ovoj JSON Schemi (ista imena polja, sva obavezna polja, vrijednosti iz "enum" lista napisane tačno tako):
\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\``;
}

export function pagePrompt(crawlResult, { language = "bosanski" } = {}) {
  return manualPrompt(pageRequest(crawlResult, language));
}

export function sitePrompt(summary, pages, { language = "bosanski" } = {}) {
  return manualPrompt(siteRequest(summary, pages, language));
}

async function callClaude({ schema, content }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("AI je odbio ovu analizu.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("AI odgovor je prekinut (predug). Pokušajte ponovo.");
  }
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    ...JSON.parse(text),
    model: response.model,
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}
