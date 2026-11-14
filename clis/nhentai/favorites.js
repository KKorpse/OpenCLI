import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { collectFavoriteCards, favoritesUrl, galleryUrl, inspectPage, thumbUrl } from './api.js';

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
    if (attempt < 3) {
      if (typeof page.sleep === 'function') await page.sleep(0.6);
      else await new Promise((r) => setTimeout(r, 600));
    }
  }
  return snapshot;
}

/**
 * Load one favourites page.
 *
 * nhentai answers deep paging with an HTTP 200 "Error 429 - You're being rate
 * limited" page that contains no cards. Treating that as the end of the list is
 * what makes a 20-page account look like a 5-page one, so wait it out and retry.
 */
async function loadPage(page, pageNo, retries = 4) {
  let waitMs = 25000;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await page.goto(favoritesUrl(pageNo));
    const snapshot = await readCards(page);
    if (snapshot.cards.length > 0) return snapshot;

    const state = await inspectPage(page);
    if (/rate limit|error 429|\\b429\\b/i.test(`${state.title} ${state.text}`)) {
      if (attempt === retries) {
        throw new CommandExecutionError(
          `nhentai: rate limited while reading favourites page ${pageNo}.`,
          'nhentai allows roughly 10 page views per minute. Wait two or three minutes, then retry 鈥?or walk pages with --delay 8000.',
        );
      }
      console.error(`[nhentai] page ${pageNo}: rate limited, waiting ${Math.round(waitMs / 1000)}s`);
      if (typeof page.sleep === 'function') await page.sleep(waitMs / 1000);
      else await new Promise((r) => setTimeout(r, waitMs));
      waitMs = Math.min(Math.round(waitMs * 1.5), 60000);
      continue;
    }
    return snapshot;
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
    { name: 'max-pages', type: 'int', default: 20, help: 'Page cap used with --all' },
    { name: 'delay', type: 'int', default: 5000, help: 'Milliseconds to wait between page loads' },
  ],
  columns: ['rank', 'id', 'title', 'page', 'thumbnail', 'url'],
  func: async (page, kwargs) => {
    const startPage = Math.max(1, Number(kwargs.page) || 1);
    const limit = Math.max(1, Number(kwargs.limit) || 25);
    const walk = Boolean(kwargs.all);
    const delay = Math.max(0, Number(kwargs.delay) || 0);
    const maxPages = Math.max(1, Number(kwargs['max-pages']) || 20);
    const lastPage = startPage + (walk ? maxPages : 1) - 1;

    const rows = [];
    let sawCards = false;

    for (let pageNo = startPage; pageNo <= lastPage; pageNo += 1) {
      const snapshot = await loadPage(page, pageNo);

      if (snapshot.cards.length === 0) {
        const state = await inspectPage(page);
        if (state.connectionError) {
          // Never report a truncated list as if it were the whole list.
          throw new CommandExecutionError(
            `nhentai: favourites page ${pageNo} did not load (connection closed).`,
            `${rows.length} row(s) from pages ${startPage}-${pageNo - 1} were read, but the list is incomplete. This is usually an IP rate limit or a proxy hiccup: wait a few minutes, then retry with --page ${pageNo}.`,
          );
        }
        if (!sawCards && /log in|log out|register|sign in/i.test(state.text)) {
          throw new AuthRequiredError(
            'nhentai: this browser session is not signed in, so the favourites list is unavailable.',
            'Sign in at https://nhentai.net/login/ in the same Edge profile, then retry `opencli nhentai favorites`.',
          );
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
      if (delay) {
        if (typeof page.sleep === 'function') await page.sleep(delay / 1000);
        else await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (!sawCards) {
      throw new EmptyResultError('nhentai: no favourite galleries were found on this account.', 'Favourite a gallery on nhentai.net, then retry.');
    }
    return rows;
  },
});
