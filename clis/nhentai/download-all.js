import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { resolve, join } from 'node:path';
import { ORIGIN } from './api.js';
import { downloadGallery } from './download-core.js';
import { enumerateFavorites, loadState, planBooks, saveState } from './sync.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRANSIENT_PAGE_RE =
  /page not found|stale page identity|target closed|browser (?:has )?disconnected|session closed|context (?:was )?destroyed|detached/i;

cli({
  site: 'nhentai',
  name: 'download-all',
  access: 'read',
  description: 'Sync every favourite gallery locally, resumable inside a time budget',
  domain: 'nhentai.net',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'output', required: true, help: 'Destination folder (required, e.g. D:\\nh)' },
    { name: 'max-favorites-pages', type: 'int', default: 100, help: 'Safety cap on favourites pages to enumerate (25 per page; the walk stops at an empty page first)' },
    { name: 'budget', type: 'int', default: 3000, help: 'Seconds of work for this run; the command stops early and saves state' },
    { name: 'timeout', type: 'int', default: 3600, help: 'Framework kill switch; must be greater than budget + 300' },
    { name: 'concurrency', type: 'int', default: 3, help: 'Parallel image downloads per gallery (1-8)' },
    { name: 'retries', type: 'int', default: 4, help: 'Attempts per image with exponential backoff' },
    { name: 'delay', type: 'int', default: 5000, help: 'Milliseconds between galleries' },
    { name: 'limit', type: 'int', default: 0, help: 'Process at most N galleries (trial runs)' },
    { name: 'folder-name', default: 'title', choices: ['title', 'id', 'title-id'], help: 'Folder naming: sanitised title (default), id, or title__id' },
    { name: 'state', default: '', help: 'State file (default <output>/.nh-sync.json)' },
    { name: 'retry-failed', type: 'bool', default: false, help: 'Only retry books previously partial or failed' },
    { name: 'refresh', type: 'bool', default: false, help: 'Re-enumerate favourites from page 1' },
    { name: 'dry-run', type: 'bool', default: false, help: 'Enumerate and plan only; download nothing' },
    { name: 'max-failures', type: 'int', default: 3, help: 'Stop this run after N consecutive gallery failures' },
    { name: 'oldest-first', type: 'bool', default: false, help: 'Process originally-favourited (oldest) galleries first, so the newest favourite ends up with the newest mtime' },
  ],
  columns: ['done', 'partial', 'failed', 'pending', 'queued', 'synced_now', 'stopped', 'exit_code', 'elapsed_s', 'state_file', 'dir'],
  func: async (page, kwargs) => {
    const startedAt = Date.now();
    const elapsedS = () => Math.round((Date.now() - startedAt) / 1000);

    const budget = Math.max(10, Number(kwargs.budget) || 3000);
    const timeout = Math.max(120, Number(kwargs.timeout) || 3600);
    if (timeout <= budget + 300) {
      throw new ArgumentError(
        '--timeout must be greater than --budget + 300 seconds',
        `Got timeout=${timeout}s and budget=${budget}s. The framework kills the process at --timeout, so it needs room to persist state first.`,
      );
    }

    const outputArg = String(kwargs.output ?? '').trim();
    if (!outputArg) throw new ArgumentError('--output is required', 'Pass a destination folder, e.g. --output D:\\nh');

    const outDir = resolve(outputArg);
    const statePath = String(kwargs.state ?? '').trim() ? resolve(String(kwargs.state)) : join(outDir, '.nh-sync.json');
    const maxPages = Math.max(1, Number(kwargs['max-favorites-pages']) || 100);
    const concurrency = Math.min(8, Math.max(1, Number(kwargs.concurrency) || 3));
    const retries = Math.max(1, Number(kwargs.retries) || 4);
    const bookDelay = Math.max(0, Number(kwargs.delay) || 0);
    const limit = Math.max(0, Number(kwargs.limit) || 0);
    const retryFailed = Boolean(kwargs['retry-failed']);
    const dryRun = Boolean(kwargs['dry-run']);
    const refresh = Boolean(kwargs.refresh);
    const maxFailures = Math.max(1, Number(kwargs['max-failures']) || 3);
    const oldestFirst = Boolean(kwargs['oldest-first']);
    const folderName = String(kwargs['folder-name'] ?? 'title');

    const state = loadState(statePath);
    if (refresh) state.favorites = { next_page: 1, ids: [], complete: false };
    const save = () => saveState(statePath, state);

    const onSigint = () => {
      try {
        state.stats.elapsed_s = elapsedS();
        save();
      } catch { /* best effort */ }
      console.error('[nhentai] interrupted — state saved; rerun the same command to resume');
      process.exit(3);
    };
    process.once('SIGINT', onSigint);

    // 1) Enumerate favourites into state.favorites.ids (resumable).
    let enumeration = { incomplete: false, reachedEnd: state.favorites.complete, capped: false, pagesRead: 0 };
    if (!state.favorites.complete || refresh) {
      console.error(`[nhentai] enumerating favourites from page ${state.favorites.next_page} (max ${maxPages})`);
      enumeration = await enumerateFavorites(page, state, { maxPages, save });
    } else {
      console.error(`[nhentai] favourites already enumerated (${state.favorites.ids.length} ids)`);
    }
    if (enumeration.capped) {
      console.error(
        `[nhentai] WARNING: favourite enumeration stopped at the ${maxPages}-page cap; ` +
          'the list may be truncated. Raise --max-favorites-pages (25 galleries per page).',
      );
    }

    // 2) Plan from disk: done / partial / pending.
    const plan = planBooks(outDir, state.favorites.ids, state);
    const countPlan = () => {
      const counts = { done: 0, partial: 0, failed: 0, pending: 0 };
      for (const book of plan.values()) {
        const tracked = state.books[book.id];
        const status = book.status === 'done' ? 'done' : tracked?.status === 'failed' ? 'failed' : book.status;
        counts[status] += 1;
      }
      return counts;
    };
    const counts = countPlan();

    let queue = [...plan.values()].filter((book) => book.status !== 'done');
    if (retryFailed) {
      queue = queue.filter((book) => {
        const tracked = state.books[book.id];
        return book.status === 'partial' || tracked?.status === 'partial' || tracked?.status === 'failed';
      });
    }
    // Favourites are enumerated newest-first, so reversing yields oldest-first:
    // the newest favourite is downloaded last and therefore keeps the newest mtime.
    if (oldestFirst) queue.reverse();
    if (limit > 0) queue = queue.slice(0, limit);

    const row = (extra = {}) => ({
      done: counts.done,
      partial: counts.partial,
      failed: counts.failed,
      pending: counts.pending,
      queued: queue.length,
      synced_now: 0,
      stopped: 'dry-run',
      exit_code: 0,
      capped: Boolean(enumeration.capped),
      elapsed_s: elapsedS(),
      state_file: statePath,
      dir: outDir,
      ...extra,
    });

    if (dryRun) {
      process.removeListener('SIGINT', onSigint);
      console.error(`[nhentai] dry run: ${queue.length} of ${state.favorites.ids.length} galleries need work`);
      // A truncated favourites list must not look like a clean dry run.
      const dryCode = enumeration.incomplete ? 4 : enumeration.capped ? 6 : 0;
      if (dryCode) process.exitCode = dryCode;
      return [row({ stopped: 'dry-run', synced_now: 0, exit_code: dryCode })];
    }

    // 3) Download within the budget, persisting state after every gallery.
    let syncedNow = 0;
    let consecutiveFailures = 0;
    let imagesDone = 0;
    // `--retry-failed` with nothing to retry must not look like "still work left",
    // otherwise an unconditional `while exit -eq 3` loop would spin forever.
    const nothingToRetry = retryFailed && queue.length === 0;
    let stopped = nothingToRetry ? 'nothing-to-retry' : queue.length === 0 ? 'nothing-to-do' : 'budget';

    const estimateBookSeconds = (book) => {
      const pages = Number(book.totalPages) || 100;
      const measured = imagesDone > 0 && elapsedS() > 0 ? elapsedS() / imagesDone : null;
      const perPage = measured && measured > 0 ? measured : 2.2 / concurrency;
      return Math.max(5, pages * perPage);
    };

    for (const book of queue) {
      const spent = elapsedS();
      const estimate = estimateBookSeconds(book);
      if (spent + estimate > budget) {
        stopped = 'budget';
        console.error(`[nhentai] budget guard: ${spent}s spent, next gallery needs ~${Math.round(estimate)}s of ${budget}s — stopping early`);
        break;
      }

      console.error(`[nhentai] ${book.id}: ${book.status}, ${book.have}/${book.totalPages ?? '?'} pages on disk`);
      let result = null;
      let lastError = null;
      let stale = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          result = await downloadGallery(page, {
            target: book.id,
            output: outDir,
            dir: book.dir ?? undefined,
            folderName,
            concurrency,
            retries,
            continueOnError: true,
            maxFailures: 10,
            delay: 120,
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const message = String(error?.message || error);
          // A stale page identity means the handle itself is dead, so retrying on
          // the same object cannot work: navigate first to obtain a fresh handle.
          if (attempt > 0 || !TRANSIENT_PAGE_RE.test(message)) {
            stale = TRANSIENT_PAGE_RE.test(message);
            break;
          }
          console.error(`[nhentai] ${book.id}: transient browser error, re-navigating and retrying — ${message.slice(0, 160)}`);
          try {
            await page.goto(ORIGIN);
          } catch { /* retry below will surface a real error */ }
          await sleep(500);
        }
      }

      if (!result && stale) {
        state.books[book.id] = {
          status: 'failed',
          dir: book.dir ?? null,
          pages: book.totalPages,
          have: book.have,
          failed: [],
          error: String(lastError?.message || lastError).slice(0, 300),
          updated_at: new Date().toISOString(),
        };
        save();
        stopped = 'stale-page';
        console.error(`[nhentai] ${book.id}: page identity is stale and did not recover — ending this run so a fresh process gets a new page handle`);
        break;
      }

      if (result) {
        imagesDone += result.saved.length;
        const status = result.failed.length || result.missing.length ? 'partial' : 'done';
        state.books[book.id] = {
          status,
          dir: result.dir,
          pages: result.totalPages,
          have: result.onDisk.length,
          failed: result.failed.map((f) => f.number),
          updated_at: new Date().toISOString(),
        };
        syncedNow += 1;
        consecutiveFailures = 0;
        stopped = 'queue-done';
      } else {
        consecutiveFailures += 1;
        state.books[book.id] = {
          status: 'failed',
          pages: book.totalPages,
          have: book.have,
          failed: [],
          error: String(lastError?.message || lastError).slice(0, 300),
          updated_at: new Date().toISOString(),
        };
        console.error(`[nhentai] ${book.id}: FAILED — ${String(lastError?.message || lastError).slice(0, 200)}`);
        if (consecutiveFailures >= maxFailures) {
          stopped = 'consecutive-failures';
          save();
          break;
        }
      }
      save();
      if (bookDelay) await sleep(bookDelay);
    }

    // 4) Recompute from disk and pick the exit code.
    const finalPlan = planBooks(outDir, state.favorites.ids, state);
    const finalCounts = { done: 0, partial: 0, failed: 0, pending: 0 };
    for (const book of finalPlan.values()) {
      const tracked = state.books[book.id];
      const status = book.status === 'done' ? 'done' : tracked?.status === 'failed' ? 'failed' : book.status;
      finalCounts[status] += 1;
    }

    let exitCode = 0;
    if (stopped === 'stale-page') exitCode = 5;
    else if (enumeration.incomplete) exitCode = 4;
    else if (enumeration.capped) exitCode = 6;
    else if (finalCounts.partial || finalCounts.failed) exitCode = 2;
    else if (!nothingToRetry && finalCounts.pending > 0) exitCode = 3;

    state.stats = {
      ...state.stats,
      done: finalCounts.done,
      partial: finalCounts.partial,
      failed: finalCounts.failed,
      pending: finalCounts.pending,
      elapsed_s: elapsedS(),
    };
    save();
    process.removeListener('SIGINT', onSigint);
    if (exitCode) process.exitCode = exitCode;

    return [
      row({
        done: finalCounts.done,
        partial: finalCounts.partial,
        failed: finalCounts.failed,
        pending: finalCounts.pending,
        queued: queue.length,
        synced_now: syncedNow,
        stopped,
        exit_code: exitCode,
        elapsed_s: elapsedS(),
      }),
    ];
  },
});
