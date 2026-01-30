// BoardGameGeek trend scraper (Cheerio + optional Playwright)
// - Scrapes BGG hot/browse pages and extracts game metadata
// - Optionally uses BGG XML API2 for reliable structured metadata
// - Saves dataset rows and full JSON per-game to Key-Value store

import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, Dataset, KeyValueStore } from 'crawlee';
import xml2js from 'xml2js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  startUrls = ['https://boardgamegeek.com/hot', 'https://boardgamegeek.com/browse/boardgame'],
  maxRequestsPerCrawl = 500,
  useBrowser = false,
  useBggApi = true,
  followInternalOnly = true,
  concurrency = 10,
} = input;

const dataset = await Dataset.open();
const kv = await KeyValueStore.open();
const proxyConfiguration = await Actor.createProxyConfiguration();

// Utility: resolve absolute
function resolveUrl(base, href) {
  try { return new URL(href, base).toString(); } catch (e) { return null; }
}

// Fetch BGG XML API2 for thing details: https://boardgamegeek.com/xmlapi2/thing?id=BGGID&stats=1
async function fetchBggApi(bggId) {
  try {
    const url = `https://boardgamegeek.com/xmlapi2/thing?id=${encodeURIComponent(bggId)}&stats=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    const json = await parser.parseStringPromise(text);
    // json.thing contains structured fields; adapt as needed
    return json;
  } catch (e) {
    return null;
  }
}

// Normalize parsed BGG API data to a compact object
function normalizeBggApi(json) {
  if (!json || !json.thing) return null;
  const t = json.thing;
  const item = {
    bgg_id: t.id,
    name: Array.isArray(t.name) ? t.name[0].value : (t.name && t.name.value) || '',
    year: t.yearpublished ? t.yearpublished.value : '',
    description: t.description ? t.description : '',
    min_players: t.minplayers ? t.minplayers.value : '',
    max_players: t.maxplayers ? t.maxplayers.value : '',
    playing_time: t.playingtime ? t.playingtime.value : '',
    designers: [],
    mechanics: [],
    categories: [],
    geek_rating: t.statistics && t.statistics.ratings && t.statistics.ratings.ranks ? t.statistics.ratings.ranks.rank : null,
    avg_rating: t.statistics && t.statistics.ratings ? t.statistics.ratings.average : null,
    num_voters: t.statistics && t.statistics.ratings ? t.statistics.ratings.usersrated : null
  };

  // designers, mechanics, categories are 'link' elements with type attribute
  const links = Array.isArray(t.link) ? t.link : (t.link ? [t.link] : []);
  for (const l of links) {
    if (!l) continue;
    const type = l.type;
    const value = l.value || l.name || '';
    if (type === 'boardgamedesigner') item.designers.push(value);
    if (type === 'boardgamemechanic') item.mechanics.push(value);
    if (type === 'boardgamecategory') item.categories.push(value);
  }
  return item;
}

// Extract game metadata from a BGG game page using Cheerio
async function extractGameFromPageCheerio({ request, $, log }) {
  const url = request.loadedUrl ?? request.url;
  log.info('Extracting game page (cheerio)', { url });

  // Basic selectors for BGG game page
  const name = $('#mainbody h1, .game-title, .header-title').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
  // BGG id in canonical link or data attributes
  let bggId = '';
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  if (canonical) {
    const m = canonical.match(/\/boardgame\/(?:.*)\/(\d+)|\/boardgame\/(\d+)/);
    if (m) bggId = m[1] || m[2] || '';
  }
  // alternate: meta property or script contains thing id
  if (!bggId) {
    const metaId = $('meta[name="og:url"]').attr('content') || '';
    const m2 = metaId.match(/\/boardgame\/(?:.*)\/(\d+)/);
    if (m2) bggId = m2[1];
  }

  // Rank / hotness are often on listing pages; on game page we collect ratings
  const avgRating = $('.gameplay .rating .rating-value, .game_rating .value').first().text().trim() || '';
  const numVoters = $('a[href$="/ratings"]').first().text().replace(/[^\d]/g, '') || '';

  const year = $('.gameplay .year, .game-title .year').first().text().replace(/[^\d]/g, '') || '';
  const designers = $('.gameplay .designer a, .wiki_rightcol a[href*="designer"]').map((i, el) => $(el).text().trim()).get() || [];
  const mechanics = $('a[href*="/boardgamemechanic/"], .gameplay .mechanic a').map((i, el) => $(el).text().trim()).get() || [];
  const categories = $('a[href*="/boardgamecategory/"], .gameplay .category a').map((i, el) => $(el).text().trim()).get() || [];
  const description = $('#mainbody #description, #overview, .game-description').first().text().trim().slice(0, 2000) || '';

  const record = {
    name,
    bgg_id: bggId || '',
    year,
    avg_rating: avgRating || '',
    num_voters: numVoters || '',
    designers,
    mechanics,
    categories,
    description,
    url,
    extracted_at: new Date().toISOString()
  };

  // If configured, enrich with BGG API
  if (useBggApi && bggId) {
    const apiJson = await fetchBggApi(bggId);
    const normalized = normalizeBggApi(apiJson);
    if (normalized) {
      Object.assign(record, {
        geek_rating: normalized.geek_rating || record.geek_rating || '',
        avg_rating: normalized.avg_rating || record.avg_rating,
        num_voters: normalized.num_voters || record.num_voters,
        designers: normalized.designers && normalized.designers.length ? normalized.designers : record.designers,
        mechanics: normalized.mechanics && normalized.mechanics.length ? normalized.mechanics : record.mechanics,
        categories: normalized.categories && normalized.categories.length ? normalized.categories : record.categories
      });
      // store raw API JSON in KV
      try {
        await kv.setValue(`games/${bggId}`, apiJson, { contentType: 'application/json' });
      } catch (e) {
        log.warning('Failed to save BGG API JSON to KV', { bggId, error: e.message });
      }
    }
  }

  await dataset.pushData(record);
  return record;
}

// Extract listing page (hot/browse) — collects entries and enqueues game pages
async function listingPageHandler({ request, $, enqueueLinks, log }) {
  const url = request.loadedUrl ?? request.url;
  log.info('Processing listing', { url });

  // Enqueue links to game pages found on listing
  await enqueueLinks({
    globs: ['**/boardgame/*', '**/thing/*', '**/boardgame/*/*'],
    transformRequestFunction: (r) => {
      if (followInternalOnly) {
        try {
          const startHost = request.userData.startHost || new URL(request.url).host;
          if (new URL(r.url).host !== startHost) return null;
        } catch (e) {
          return null;
        }
      }
      return r;
    }
  });

  // On some listing pages each row has rank and hotness; attempt to capture quick stats
  const rows = $('.collection_table tr, .table tr, .ranked-item, .hot-item').toArray();
  for (const row of rows) {
    const $row = $(row);
    // try selectors… robust fallback
    const link = $row.find('a[href*="/boardgame/"], a[href*="/thing/"]').first().attr('href');
    const abs = link ? resolveUrl(url, link) : null;
    const name = $row.find('a[href*="/boardgame/"], a[href*="/thing/"]').first().text().trim() || '';
    const rankText = $row.find('.collection_rank, .rank').first().text().trim().replace(/[^\d]/g, '') || '';
    const hotness = $row.find('.hotness, .post_hotness, .rank_change').first().text().trim() || '';

    const rowRecord = {
      name,
      url: abs,
      rank: rankText || '',
      hotness: hotness || '',
      source_page: url,
      extracted_at: new Date().toISOString()
    };
    if (abs) {
      // push a lightweight record; individual game page handler will enrich
      await dataset.pushData(rowRecord);
    }
  }
}

// Playwright variants
async function extractGameFromPagePlaywright({ page, request, log }) {
  const url = request.loadedUrl ?? request.url;
  log.info('Extracting game page (playwright)', { url });
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  } catch (e) {}
  const name = (await page.locator('#mainbody h1, .game-title').first().innerText().catch(() => '')) || '';
  let bggId = '';
  const canonical = await page.locator('link[rel="canonical"]').first().getAttribute('href').catch(() => '') || '';
  if (canonical) {
    const m = canonical.match(/\/boardgame\/(?:.*)\/(\d+)|\/boardgame\/(\d+)/);
    if (m) bggId = m[1] || m[2] || '';
  }

  const avgRating = (await page.locator('.gameplay .rating .rating-value').first().innerText().catch(() => '')).trim() || '';
  const numVoters = (await page.locator('a[href$="/ratings"]').first().innerText().catch(() => '')).replace(/[^\d]/g, '') || '';
  const year = (await page.locator('.gameplay .year, .game-title .year').first().innerText().catch(() => '')).replace(/[^\d]/g, '') || '';
  const designers = await page.$$eval('.gameplay .designer a, .wiki_rightcol a[href*="designer"]', els => els.map(e => e.innerText.trim())).catch(() => []);
  const mechanics = await page.$$eval('a[href*="/boardgamemechanic/"], .gameplay .mechanic a', els => els.map(e => e.innerText.trim())).catch(() => []);
  const categories = await page.$$eval('a[href*="/boardgamecategory/"], .gameplay .category a', els => els.map(e => e.innerText.trim())).catch(() => []);
  const description = (await page.locator('#mainbody #description, #overview, .game-description').first().innerText().catch(() => '')).slice(0, 2000) || '';

  const record = {
    name,
    bgg_id: bggId || '',
    year,
    avg_rating: avgRating || '',
    num_voters: numVoters || '',
    designers,
    mechanics,
    categories,
    description,
    url,
    extracted_at: new Date().toISOString()
  };

  if (useBggApi && bggId) {
    const apiJson = await fetchBggApi(bggId);
    const normalized = normalizeBggApi(apiJson);
    if (normalized) {
      Object.assign(record, {
        geek_rating: normalized.geek_rating || record.geek_rating || '',
        avg_rating: normalized.avg_rating || record.avg_rating,
        num_voters: normalized.num_voters || record.num_voters,
        designers: normalized.designers && normalized.designers.length ? normalized.designers : record.designers,
        mechanics: normalized.mechanics && normalized.mechanics.length ? normalized.mechanics : record.mechanics,
        categories: normalized.categories && normalized.categories.length ? normalized.categories : record.categories
      });
      try {
        await kv.setValue(`games/${bggId}`, apiJson, { contentType: 'application/json' });
      } catch (e) {
        log.warning('Failed to save BGG API JSON to KV', { bggId, error: e.message });
      }
    }
  }

  await dataset.pushData(record);
  return record;
}

// Run crawler(s)
if (!useBrowser) {
  const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    maxConcurrency: concurrency,
    async requestHandler(ctx) {
      const { request, $, enqueueLinks, log } = ctx;
      const url = request.loadedUrl ?? request.url;
      // If page looks like a game page (/boardgame/ or /thing/) extract details
      if (/\/boardgame\/|\/thing\//i.test(url)) {
        await extractGameFromPageCheerio(ctx);
      } else {
        await listingPageHandler(ctx);
      }
    }
  });

  const startRequests = (startUrls || []).map(u => {
    try { const p = new URL(u); return { url: u, userData: { startHost: p.host } }; } catch { return { url: u, userData: {} }; }
  });

  await crawler.run(startRequests);
} else {
  const crawler = new PlaywrightCrawler({
    launchContext: {},
    maxRequestsPerCrawl,
    async requestHandler(ctx) {
      const { request, page } = ctx;
      const url = request.loadedUrl ?? request.url;
      if (/\/boardgame\/|\/thing\//i.test(url)) {
        await extractGameFromPagePlaywright(ctx);
      } else {
        // simplified listing handler: enqueue game links and capture quick rows (optional)
        await ctx.enqueueLinks({
          globs: ['**/boardgame/*', '**/thing/*'],
          transformRequestFunction: (r) => {
            if (followInternalOnly) {
              try {
                const startHost = request.userData.startHost || new URL(request.url).host;
                if (new URL(r.url).host !== startHost) return null;
              } catch (e) { return null; }
            }
            return r;
          },
          userData: { startHost: request.userData.startHost || new URL(request.url).host }
        });
      }
    }
  });

  const startRequests = (startUrls || []).map(u => {
    try { const p = new URL(u); return { url: u, userData: { startHost: p.host } }; } catch { return { url: u, userData: {} }; }
  });

  await crawler.run(startRequests);
}

await Actor.exit();
