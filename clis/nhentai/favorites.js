import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CliError, EmptyResultError } from '@jackwener/opencli/errors';
import { collectFavoriteCards, favoritesUrl, galleryUrl, inspectPage, thumbUrl } from './api.js';

const RATE_LIMIT_RE =
  /rate limit|error 429|\b429\b|too many requests|just a moment|attention required|access denied|forbidden|challenge/i;
const LIST_PAGE_RE = /favourites|favorites|log out|my favorites/i;
const TEMPFAIL = 75;

async function pause(page, seconds) {
  if (typeof page.sleep === 'function') await page.sleep(seconds);
  else await new Promise((r) => setTimeout(r, seconds * 1000));
}

/**
 * The page is server-rendered, but a reused automation tab can still answer the
 * first read before the cards are in the DOM. Poll briefly instead of treating a
 * transient empty document as "no favourites".
 */
async function readCards(page) {
  let snapshot = { cards: [], bodyText: '', hrefs: [] };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    snapshot = await collectFavoriteCards(page);
    if (snapshot.cards.length > 0) return snapshot;
    if (attempt < 3) await pause(page, 0.6);
  }
  return snapshot;
}

/**
 * Load one favourites page.
 *
 * A 0-card page is ambiguous: nhentai serves an HTTP 200 "Error 429 - nhentai"
 * page while rate limiting, and a connection reset renders chrome-error://. Both
 * have no `.gallery` cards, so treating "0 cards" as "end of list" silently
 * truncates a 20-page account to however many pages loaded before the limit.
 * Only a still-recognisable favourites page with no cards counts as the end.
 */
async function loadPage(page, pageNo, retries = 4) {
  let waitMs = 25000;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await page.goto(favoritesUrl(pageNo));
    const snapshot = await readCards(page);
    if (snapshot.cards.length > 0) return snapshot;

    const view = await inspectPage(page);
    const merged = `${view.title} ${view.text}`;
    const looksLikeList = LIST_PAGE_RE.test(view.text);
    const suspicious = RATE_LIMIT_RE.test(merged) || view.connectionError || !looksLikeList;

    if (!suspicious) return snapshot; // genuine end of the favourites list

    if (attempt === retries) {
      throw new CliError(
        'RATE_LIMITED',
        `nhentai: favourites page ${pageNo} could not be read (rate limited or blocked).`,
        'This is temporary: wait two or three minutes, then retry. A partially read list is never returned as if it were complete.',
        TEMPFAIL,
      );
    }
    console.error(`[nhentai] page ${pageNo}: no galleries and the page looks blocked — waiting ${Math.round(waitMs / 1000)}s`);
    await pause(page, waitMs / 1000);
    waitMs = Math.min(Math.round(waitMs * 1.5), 60000);
  }
  return { cards: [], bodyText: '', hrefs: [] };
}

cli({
  site: 'nhentai',
  name: 'favorites',
  access: 'read',
  description: "List the logged-in account's favourite galleries (reads the browser session)",
  domain: 'nhentai.net',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'page', type: 'int', default: 1, help: 'Favourites page (25 per page)' },
    { name: 'limit', type: 'int', default: 25, help: 'Max rows to print' },
    { name: 'all', type: 'bool', default: false, help: 'Keep going through consecutive pages' },
    { name: 'max-pages', type: 'int', default: 100, help: 'Safety cap on pages walked with --all (25 galleries per page)' },
    { name: 'delay', type: 'int', default: 5000, help: 'Milliseconds to wait between page loads' },
  ],
  columns: ['rank', 'id', 'title', 'page', 'thumbnail', 'url'],
  func: async (page, kwargs) => {
    const startPage = Math.max(1, Number(kwargs.page) || 1);
    const limit = Math.max(1, Number(kwargs.limit) || 25);
    const walk = Boolean(kwargs.all);
    const delay = Math.max(0, Number(kwargs.delay) || 0);
    const maxPages = Math.max(1, Number(kwargs['max-pages']) || 100);
    const lastPage = startPage + (walk ? maxPages : 1) - 1;

    const rows = [];
    let sawCards = false;
    let truncated = false;

    for (let pageNo = startPage; pageNo <= lastPage; pageNo += 1) {
      let snapshot;
      try {
        snapshot = await loadPage(page, pageNo);
      } catch (error) {
        if (error?.code === 'RATE_LIMITED') {
          const read = rows.length;
          throw new CliError(
            'RATE_LIMITED',
            read > 0
              ? `nhentai: read ${read} favourite(s) from pages ${startPage}-${pageNo - 1}, but page ${pageNo} could not be loaded (rate limited or blocked).`
              : `nhentai: favourites page ${pageNo} could not be loaded (rate limited or blocked).`,
            read > 0
              ? `Wait two or three minutes, then continue with \`opencli nhentai favorites --page ${pageNo} --all\`.`
              : 'Wait two or three minutes, then retry. A blocked page is never reported as an empty favourites list.',
            TEMPFAIL,
          );
        }
        throw error;
      }

      if (snapshot.cards.length === 0) {
        if (!sawCards) {
          const view = await inspectPage(page);
          if (/log in|log out|register|sign in/i.test(view.text) && !LIST_PAGE_RE.test(view.text)) {
            throw new AuthRequiredError(
              'nhentai: this browser session is not signed in, so the favourites list is unavailable.',
              'Sign in at https://nhentai.net/login/ in the same Edge profile, then retry `opencli nhentai favorites`.',
            );
          }
          throw new EmptyResultError('nhentai: no favourite galleries were found on this account.', 'Favourite a gallery on nhentai.net, then retry.');
        }
        console.error(`[nhentai] page ${pageNo}: no galleries, stopping`);
        break;
      }
      sawCards = true;
      console.error(`[nhentai] page ${pageNo}: ${snapshot.cards.length} galleries`);

      for (const card of snapshot.cards) {
        if (rows.length >= limit) break;
        rows.push({
          rank: rows.length + 1,
          id: card.id,
          title: String(card.title).replace(/\s+/g, ' ').trim(),
          page: pageNo,
          thumbnail: thumbUrl(card.thumb),
          url: galleryUrl(card.id),
        });
      }
      if (rows.length >= limit || !walk) break;

      const hasNext = snapshot.hrefs.some((href) => href.includes(`page=${pageNo + 1}`));
      if (!hasNext) break;
      if (pageNo === lastPage) truncated = walk;
      if (delay) await pause(page, delay / 1000);
    }

    if (truncated) {
      console.error(
        `[nhentai] WARNING: stopped at the ${maxPages}-page cap; more favourites exist. ` +
          'Raise --max-pages (25 galleries per page).',
      );
    }

    if (!sawCards) {
      throw new EmptyResultError('nhentai: no favourite galleries were found on this account.', 'Favourite a gallery on nhentai.net, then retry.');
    }
    return rows;
  },
});
