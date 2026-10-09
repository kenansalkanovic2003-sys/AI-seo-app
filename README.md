# AI SEO App

Web aplikacija koja za uneseni URL radi SEO analizu stranice:

1. **Tehničko skeniranje** (bez AI-ja) – HTTPS, status, brzina odziva, title, meta description, H1/H2, alt tekst slika, canonical, noindex, lang, viewport, Open Graph, JSON-LD, robots.txt, sitemap, favicon. Rezultat je tehnička ocjena 0–100.
2. **AI analiza (Claude)** – na osnovu prikupljenih podataka AI piše konkretan plan: ukupna ocjena, prioritetni problemi s rješenjima, novi title / meta description / H1 (sa Google SERP pregledom), ciljne ključne riječi, struktura naslova, preporuke za sadržaj i gotov JSON-LD kod.

3. **Skeniranje cijelog sajta (sitemap)** – tab „Cijeli sajt“: čita robots.txt i XML sitemap (podržava sitemap index i `.xml.gz`), poštuje `Disallow` pravila, skenira do 200 stranica paralelno i prikazuje:
   - probleme koji se ponavljaju i na koliko stranica,
   - duple title / meta description / H1,
   - greške 4xx/5xx, preusmjerene URL-ove u sitemapu, canonical na drugu stranicu, noindex stranice,
   - tabelu svih stranica (filter, sortiranje, „AI analiza“ za pojedinačnu stranicu),
   - AI plan za cijeli sajt: problemi na nivou šablona, stranice koje prve treba popraviti, strategija sadržaja, interno linkovanje.

   Ako sajt nema sitemap, skeniraju se linkovi s početne stranice. Skeniranje se može zaustaviti, a izvještaj se pravi od stranica obrađenih do tada.

## Pokretanje

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # ključ sa https://console.anthropic.com
npm start
```

Otvorite http://localhost:3000, unesite URL i kliknite **Analiziraj**.

## API

| Endpoint | Tijelo | Opis |
|---|---|---|
| `POST /api/scan` | `{ "url": "primjer.ba" }` | Samo tehničko skeniranje |
| `POST /api/ai` | `{ "scan": <rezultat /api/scan>, "language": "bosanski" }` | AI preporuke za postojeći scan |
| `POST /api/site-scan` | `{ "url": "primjer.ba", "maxPages": 50 }` | Skeniranje sajta preko sitemapa; odgovor je NDJSON stream događaja (`discovered`, `page`, `pageError`, `done`) |
| `POST /api/site-ai` | `{ "summary": ..., "pages": [...], "language": "bosanski" }` | AI plan za sajt (iz `done` događaja) |
| `POST /api/analyze` | `{ "url": "primjer.ba", "language": "bosanski" }` | Scan + AI u jednom pozivu |

```bash
curl -X POST localhost:3000/api/analyze -H 'Content-Type: application/json' -d '{"url":"primjer.ba"}'
```

## Podešavanja (env varijable)

- `ANTHROPIC_API_KEY` – obavezno za AI dio
- `CLAUDE_MODEL` – model (zadano `claude-opus-5-5`)
- `PORT` – port servera (zadano 3000)
- `ALLOW_PRIVATE_HOSTS=1` – dozvoli skeniranje localhost/internih adresa (samo za lokalno testiranje; inače su blokirane radi sigurnosti)

## Struktura

- `src/crawler.js` – preuzimanje stranice, izvlačenje SEO podataka (cheerio), tehničke provjere i ocjena
- `src/site.js` – čitanje sitemapa i robots.txt, paralelno skeniranje stranica, zbirni izvještaj za sajt
- `src/ai.js` – Claude API poziv sa strukturiranim JSON izlazom
- `src/server.js` – Express server i API rute
- `public/index.html` – web sučelje
