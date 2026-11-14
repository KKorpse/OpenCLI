/**
 * Sync state + planning for `download-all`.
 *
 * The state file is the only source of truth for resumption, so every write is
 * atomic (tmp + rename): a process killed mid-write must never leave truncated
 * JSON behind.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectFavoriteCards, favoritesUrl, inspectPage, writeJsonAtomic } from './api.js';
import { listDownloadedPages } from './download-core.js';

export const STATE_VERSION = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshState() {
  return {
    version: STATE_VERSION,
    favorites: { next_page: 1, ids: [], complete: false },
    books: {},
    stats: {},
  };
}

export function loadState(statePath) {
  if (!existsSync(statePath)) return freshState();
  try {
    // Notepad and PowerShell write a UTF-8 BOM by default; JSON.parse rejects it.
    const raw = readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STATE_VERSION) return freshState();
    parsed.favorites ??= { next_page: 1, ids: [], complete: false };
    parsed.favorites.ids = Array.isArray(parsed.favorites.ids) ? parsed.favorites.ids : [];
    parsed.favorites.next_page = Number(parsed.favorites.next_page) || 1;
    parsed.favorites.complete = Boolean(parsed.favorites.complete);
    parsed.books = parsed.books && typeof parsed.books === 'object' ? parsed.books : {};
    parsed.stats = parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {};
    return parsed;
  } catch {
    try {
      const backup = `${statePath}.corrupt-${Date.now()}`;
      writeFileSync(backup, readFileSync(statePath));
      console.error(`[nhentai] state file was unreadable; backed up to ${backup}`);
    } catch { /* nothing else to do */ }
    return freshState();
  }
}

export function saveState(statePath, state) {
  state.stats = { ...state.stats, updated_at: new Date().toISOString() };
  writeJsonAtomic(statePath, state);
}

/** Decide done / partial / pending for every tracked gallery by looking at disk. */
export function planBooks(outDir, ids) {
  const plan = new Map();
  for (const id of ids) {
    const dir = join(outDir, String(id));
    const metaPath = join(dir, 'metadata.json');
    let totalPages = null;
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        totalPages = Number(meta?.raw?.num_pages) || Number(meta?.gallery?.pages) || null;
      } catch { /* keep null */ }
    }
    const have = listDownloadedPages(dir).length;
    const status = totalPages && have >= totalPages ? 'done' : have > 0 ? 'partial' : 'pending';
    plan.set(id, { id, dir, totalPages, have, status });
  }
  return plan;
}

/**
 * Walk the favourites pages into `state.favorites.ids`.
 *
 * A 0-card page is only trusted as "end of list" when it still looks like the
 * favourites page. Rate-limit and challenge pages are retried, and after the
 * retries the enumeration is reported as incomplete instead of "account has no
 * favourites" — the bug that made a 20-page account look empty.
 */
export async function enumerateFavorites(page, state, options = {}) {
  const maxPages = Math.max(1, Number(options.maxPages) || 20);
  const save = options.save;
  const retries = Math.max(0, Number(options.retries ?? 3));
  const backoffMs = Math.max(1000, Number(options.backoffMs) || 20000);
  const delayMs = Math.max(0, Number(options.delayMs ?? 3000));

  let pageNo = Math.max(1, Number(state.favorites.next_page) || 1);
  let pagesRead = 0;

  while (pageNo <= maxPages) {
    let cards = [];
    let gaveUp = false;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const started = Date.now();
      await page.goto(favoritesUrl(pageNo));
      const snapshot = await collectFavoriteCards(page);
      const elapsed = Date.now() - started;

      if (snapshot.cards.length > 0) {
        cards = snapshot.cards;
        break;
      }

      const view = await inspectPage(page);
      const looksLikeList = /favourites|favorites|log out|my favorites/i.test(view.text);
      const looksLikeError = /rate limit|error 429|just a moment|attention required|too many requests|access denied|forbidden/i.test(
        `${view.title} ${view.text}`,
      );
      const tooSlow = elapsed > 3000;

      if (looksLikeError || !looksLikeList || tooSlow) {
        if (attempt < retries) {
          console.error(`[nhentai] favourites page ${pageNo}: empty/blocked after ${Math.round(elapsed)}ms, waiting ${Math.round(backoffMs / 1000)}s`);
          await sleep(backoffMs);
          continue;
        }
        gaveUp = true;
        break;
      }

      // Genuine end of the favourites list.
      state.favorites.complete = true;
      state.favorites.next_page = pageNo;
      save?.();
      return { incomplete: false, pagesRead, reachedEnd: true, capped: false };
    }

    if (gaveUp) {
      // Persist what we have; the caller turns this into exit code 4.
      save?.();
      return { incomplete: true, pagesRead, reachedEnd: false, capped: false, failedPage: pageNo };
    }

    const seen = new Set(state.favorites.ids);
    for (const card of cards) {
      if (!seen.has(card.id)) {
        seen.add(card.id);
        state.favorites.ids.push(card.id);
      }
    }
    state.favorites.next_page = pageNo + 1;
    state.favorites.complete = false;
    save?.();

    pagesRead += 1;
    pageNo += 1;
    if (pageNo <= maxPages && delayMs) await sleep(delayMs);
  }

  save?.();
  return { incomplete: false, pagesRead, reachedEnd: false, capped: pageNo > maxPages };
}
