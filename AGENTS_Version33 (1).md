## BoardGameGeek trend scraper — AGENTS

This Actor discovers trending/hot games on BoardGameGeek and collects metadata per game. It supports:
- CheerioCrawler for fast HTML scraping of listing and game pages.
- PlaywrightCrawler for JS-heavy rendering (slower).
- Optional BGG XML API2 enrichment (recommended for structured fields and ratings).

Do:
- Prefer BGG XML API2 (https://boardgamegeek.com/xmlapi2) for structured metadata and ratings when possible.
- Respect BoardGameGeek's robots.txt, rate limits and Terms of Service. Use modest concurrency and proxies for production runs.
- For time-series trend tracking, schedule the Actor to run periodically and store snapshots in Key-Value Store (e.g., key: snapshots/YYYY-MM-DD/).
- Use the dataset for aggregated query and the Key-Value store for raw per-game JSON.

Don't:
- Don't overload the site. Avoid aggressive parallelism and infinite crawls across unrelated domains.
- Don't scrape user accounts or private data.

Suggested next steps you can ask me to implement:
- Add scheduled snapshot mode + historical storage (KV) and a daily diff summary.
- Normalize ratings to numeric types and produce CSV exports per-run.
- Add pagination support for browse endpoints and sitemap-driven start input.
- Add rate-limit/backoff handling for the BGG XML API (it may return 202 when data is being prepared).
- Add transforms to compute trending deltas (rank change vs previous snapshot).

Quick local setup
1) Create directory and paste files above into the corresponding paths.
2) Install dependencies:
   - npm install
3) Run locally:
   - node src/main.js
   - or apify run

If you'd like, I can implement one of the suggested next steps now. Tell me which one.