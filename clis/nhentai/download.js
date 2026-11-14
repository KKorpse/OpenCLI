import { cli, Strategy } from '@jackwener/opencli/registry';
import { resolve, join, extname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  nhGet,
  parseGalleryId,
  parsePageRange,
  formatDetail,
  resolveProxyFor,
  downloadBinary,
  assertImageData,
  saveBinaryAtomic,
  imageUrl,
  galleryUrl,
} from './api.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

cli({
  site: 'nhentai',
  name: 'download',
  access: 'read',
  description: 'Download gallery images (and a metadata.json) to a local folder',
  domain: 'nhentai.net',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'target', positional: true, required: true, help: 'Gallery id or URL' },
    { name: 'output', default: './nhentai', help: 'Parent folder; images land in <output>/<gallery-id>/' },
    { name: 'pages', default: '', help: 'Page selection, e.g. "1-5" or "1,3,9"; empty means all' },
    { name: 'proxy', default: '', help: 'HTTP proxy for image downloads; auto-detected from env / Windows settings' },
    { name: 'retries', type: 'int', default: 4, help: 'Attempts per image with exponential backoff' },
    { name: 'concurrency', type: 'int', default: 3, help: 'Parallel image downloads (1-8)' },
    { name: 'continue-on-error', type: 'bool', default: true, help: 'Keep going when a page fails; false aborts on first failure' },
    { name: 'max-failures', type: 'int', default: 10, help: 'Stop scheduling new pages after this many failures' },
    { name: 'overwrite', type: 'bool', default: false, help: 'Re-download files that already exist' },
    { name: 'delay', type: 'int', default: 120, help: 'Milliseconds to wait between images' },
  ],
  columns: ['id', 'title', 'pages', 'saved', 'skipped', 'failed_count', 'failed', 'dir'],
  func: async (page, kwargs) => {
    const id = parseGalleryId(kwargs.target);
    const detail = await nhGet(page, `/api/v2/galleries/${id}`, `gallery ${id}`);
    const allPages = Array.isArray(detail?.pages) ? detail.pages : [];
    if (allPages.length === 0) throw new Error(`nhentai: gallery ${id} has no page list.`);

    const selected = parsePageRange(kwargs.pages, Number(detail.num_pages) || allPages.length);
    const byNumber = new Map(allPages.map((p) => [Number(p.number), p]));
    const overwrite = Boolean(kwargs.overwrite);
    const delay = Math.max(0, Number(kwargs.delay) || 0);
    const retries = Math.max(1, Number(kwargs.retries) || 4);
    const concurrency = Math.min(8, Math.max(1, Number(kwargs.concurrency) || 3));
    const continueOnError = kwargs['continue-on-error'] === undefined || Boolean(kwargs['continue-on-error']);
    const maxFailures = Math.max(1, Number(kwargs['max-failures']) || 10);
    const explicitProxy = String(kwargs.proxy ?? '').trim();
    const outDir = resolve(String(kwargs.output ?? './nhentai'), String(id));

    mkdirSync(outDir, { recursive: true });
    console.error(`[nhentai] gallery ${id}: ${selected.length}/${allPages.length} pages -> ${outDir}`);

    // Metadata is written before any image, so a failed run still leaves something reusable.
    const meta = {
      source: galleryUrl(id),
      fetched_at: new Date().toISOString(),
      gallery: formatDetail(detail, { full: true }),
      pages: selected.map((n) => {
        const p = byNumber.get(n);
        return { number: n, image: p ? imageUrl(p.path) : null, width: p?.width ?? null, height: p?.height ?? null };
      }),
      raw: detail,
    };
    writeFileSync(join(outDir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8');

    const tasks = [];
    for (const number of selected) {
      const pageInfo = byNumber.get(number);
      if (!pageInfo?.path) {
        console.error(`[nhentai] page ${number}: missing path, skipped`);
        continue;
      }
      const ext = extname(pageInfo.path) || '.jpg';
      tasks.push({
        number,
        ext,
        url: imageUrl(pageInfo.path),
        file: join(outDir, `${String(number).padStart(3, '0')}${ext}`),
      });
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
    const writeProgress = () => {
      writeFileSync(
        progressPath,
        JSON.stringify(
          { gallery: id, total: tasks.length, saved, failed: failed.map((f) => f.number), skipped, updated_at: new Date().toISOString() },
          null,
          2,
        ),
        'utf8',
      );
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
          const proxy = resolveProxyFor(task.url, explicitProxy);
          const body = await downloadBinary(task.url, proxy, { retries });
          assertImageData(body, task.ext, task.url);
          saveBinaryAtomic(task.file, body);
          saved.push(task.number);
          const done = saved.length + failed.length + skipped.length;
          console.error(`[nhentai] ${done}/${tasks.length} page ${task.number}: ${(body.length / 1024).toFixed(0)} KB`);
        } catch (error) {
          if (!continueOnError) throw error;
          failed.push({ number: task.number, error: String(error?.message || error).slice(0, 200) });
          console.error(`[nhentai] page ${task.number}: FAILED — ${String(error?.message || error).slice(0, 160)}`);
        }
        writeProgress();
        if (delay) await sleep(delay);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(pending.length, 1)) }, () => worker()));
    writeProgress();

    const failedNumbers = failed.map((f) => f.number).sort((a, b) => a - b);
    if (failedNumbers.length && failed.length >= maxFailures) {
      console.error(`[nhentai] stopped after ${failed.length} failures (--max-failures ${maxFailures}); rerun to retry the rest`);
    }
    if (failedNumbers.length) {
      console.error(`[nhentai] ${failedNumbers.length} page(s) failed: ${failedNumbers.join(', ')}`);
      // Partial success: keep the JSON payload, but signal a non-zero status.
      process.exitCode = 2;
    }

    return [
      {
        id,
        title: detail?.title?.pretty || detail?.title?.english || '(untitled)',
        pages: selected.length,
        saved: saved.length,
        skipped: skipped.length,
        failed_count: failed.length,
        failed: failedNumbers,
        dir: outDir,
      },
    ];
  },
});
