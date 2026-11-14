/**
 * Shared gallery downloader.
 *
 * `download` and `download-all` both call this so the two commands cannot drift
 * apart. It is responsible for one gallery only: metadata, per-image retries,
 * bounded concurrency, atomic writes, progress/errors artefacts and the result
 * object the commands report.
 */
import { resolve, join, extname, basename } from 'node:path';
import { existsSync, mkdirSync, appendFileSync, readdirSync, writeFileSync } from 'node:fs';
import {
  nhGet,
  parseGalleryId,
  parsePageRange,
  formatDetail,
  resolveProxyFor,
  downloadBinary,
  assertImageData,
  saveBinaryAtomic,
  writeJsonAtomic,
  imageUrl,
  galleryUrl,
} from './api.js';
import { resolveGalleryDir } from './naming.js';

const IMAGE_FILE_RE = /^(\d+)\.(jpe?g|png|gif|webp)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Page numbers that already exist as image files in `dir`. */
export function listDownloadedPages(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .map((name) => IMAGE_FILE_RE.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function downloadGallery(page, options = {}) {
  const startedAt = Date.now();
  const id = parseGalleryId(options.target);
  const proxy = String(options.proxy ?? '').trim();
  const retries = Math.max(1, Number(options.retries) || 4);
  const concurrency = Math.min(8, Math.max(1, Number(options.concurrency) || 3));
  const continueOnError = options.continueOnError !== false;
  const maxFailures = Math.max(1, Number(options.maxFailures) || 10);
  const overwrite = Boolean(options.overwrite);
  const delay = Math.max(0, Number(options.delay ?? 120) || 0);
  const quiet = Boolean(options.quiet);

  const detail = await nhGet(page, `/api/v2/galleries/${id}`, `gallery ${id}`);
  const title = detail?.title?.pretty || detail?.title?.english || detail?.title?.japanese || `gallery ${id}`;
  // The folder name needs the title, so it can only be resolved after the fetch.
  const outDir = resolveGalleryDir(String(options.output ?? './nhentai'), {
    id,
    title,
    mode: String(options.folderName ?? 'title'),
    dir: options.dir,
  });

  const allPages = Array.isArray(detail?.pages) ? detail.pages : [];
  if (allPages.length === 0) throw new Error(`nhentai: gallery ${id} has no page list.`);

  const totalPages = Number(detail.num_pages) || allPages.length;
  const selected = parsePageRange(options.pages ?? '', totalPages);
  const byNumber = new Map(allPages.map((p) => [Number(p.number), p]));
  const log = (message) => { if (!quiet) console.error(message); };

  mkdirSync(outDir, { recursive: true });
  log(`[nhentai] gallery ${id}: ${selected.length}/${allPages.length} pages -> ${outDir}`);

  // The identity file is written before the first image: a half-downloaded
  // gallery is still recognisable by `<id>.json` when planning the next run.
  writeJsonAtomic(join(outDir, `${id}.json`), {
    source: galleryUrl(id),
    fetched_at: new Date().toISOString(),
    gallery: formatDetail(detail, { full: true }),
    pages: selected.map((n) => {
      const p = byNumber.get(n);
      return { number: n, image: p ? imageUrl(p.path) : null, width: p?.width ?? null, height: p?.height ?? null };
    }),
    raw: detail,
  });

  const tasks = [];
  for (const number of selected) {
    const pageInfo = byNumber.get(number);
    if (!pageInfo?.path) {
      log(`[nhentai] page ${number}: missing path, skipped`);
      continue;
    }
    const ext = extname(pageInfo.path) || '.jpg';
    tasks.push({ number, ext, url: imageUrl(pageInfo.path), file: join(outDir, `${String(number).padStart(3, '0')}${ext}`) });
  }

  const skipped = [];
  const pending = [];
  for (const task of tasks) {
    if (!overwrite && existsSync(task.file)) skipped.push(task.number);
    else pending.push(task);
  }

  const saved = [];
  const failed = [];
  const progressPath = join(outDir, 'progress.json');
  const errorsPath = join(outDir, 'errors.jsonl');
  writeFileSync(errorsPath, '', 'utf8');

  const writeProgress = () => {
    writeJsonAtomic(progressPath, {
      gallery: id,
      total_pages: totalPages,
      selected: selected.length,
      saved: listDownloadedPages(outDir),
      skipped,
      failed: failed.map((f) => f.number),
      updated_at: new Date().toISOString(),
    });
  };
  writeProgress();

  let cursor = 0;
  const worker = async () => {
    while (true) {
      if (failed.length >= maxFailures) return;
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      const task = pending[index];
      try {
        const proxyForTask = resolveProxyFor(task.url, proxy);
        const body = await downloadBinary(task.url, proxyForTask, { retries });
        assertImageData(body, task.ext, task.url);
        saveBinaryAtomic(task.file, body);
        saved.push(task.number);
        const done = saved.length + failed.length + skipped.length;
        log(`[nhentai] ${done}/${tasks.length} page ${task.number}: ${(body.length / 1024).toFixed(0)} KB`);
      } catch (error) {
        const message = String(error?.message || error).slice(0, 300);
        failed.push({ number: task.number, error: message });
        log(`[nhentai] page ${task.number}: FAILED — ${message.slice(0, 160)}`);
        appendFileSync(
          errorsPath,
          `${JSON.stringify({
            page: task.number,
            url: task.url,
            attempts: error?.attemptCount ?? null,
            errors: Array.isArray(error?.attempts) ? error.attempts : [],
            message,
            at: new Date().toISOString(),
          })}\n`,
          'utf8',
        );
        if (!continueOnError) throw error;
      }
      writeProgress();
      if (delay) await sleep(delay);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(pending.length, 1)) }, () => worker()));
  writeProgress();

  const onDisk = listDownloadedPages(outDir);
  return {
    id,
    title,
    totalPages,
    selectedCount: selected.length,
    saved: saved.sort((a, b) => a - b),
    skipped: skipped.sort((a, b) => a - b),
    failed: failed.sort((a, b) => a.number - b.number),
    onDisk,
    missing: selected.filter((n) => !onDisk.includes(n)),
    dir: outDir,
    folder: basename(outDir),
    durationMs: Date.now() - startedAt,
  };
}
