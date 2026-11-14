import { cli, Strategy } from '@jackwener/opencli/registry';
import { resolve, join, extname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  nhGet,
  parseGalleryId,
  parsePageRange,
  formatDetail,
  detectProxy,
  downloadBinary,
  imageUrl,
  galleryUrl,
} from './api.js';

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
    { name: 'overwrite', type: 'bool', default: false, help: 'Re-download files that already exist' },
    { name: 'delay', type: 'int', default: 120, help: 'Milliseconds to wait between images' },
  ],
  columns: ['id', 'title', 'pages', 'saved', 'skipped', 'dir'],
  func: async (page, kwargs) => {
    const id = parseGalleryId(kwargs.target);
    const detail = await nhGet(page, `/api/v2/galleries/${id}`, `gallery ${id}`);
    const allPages = Array.isArray(detail?.pages) ? detail.pages : [];
    if (allPages.length === 0) throw new Error(`nhentai: gallery ${id} has no page list.`);

    const selected = parsePageRange(kwargs.pages, Number(detail.num_pages) || allPages.length);
    const byNumber = new Map(allPages.map((p) => [Number(p.number), p]));
    const overwrite = Boolean(kwargs.overwrite);
    const delay = Math.max(0, Number(kwargs.delay) || 0);
    const outDir = resolve(String(kwargs.output ?? './nhentai'), String(id));
    const proxy = String(kwargs.proxy ?? '').trim() || detectProxy();

    mkdirSync(outDir, { recursive: true });
    console.error(`[nhentai] gallery ${id}: ${selected.length}/${allPages.length} pages -> ${outDir}${proxy ? ` (proxy ${proxy})` : ''}`);

    let saved = 0;
    let skipped = 0;
    for (let i = 0; i < selected.length; i += 1) {
      const number = selected[i];
      const pageInfo = byNumber.get(number);
      if (!pageInfo?.path) {
        console.error(`[nhentai] page ${number}: missing path, skipped`);
        continue;
      }
      const ext = extname(pageInfo.path) || '.jpg';
      const file = join(outDir, `${String(number).padStart(3, '0')}${ext}`);
      if (!overwrite && existsSync(file)) {
        skipped += 1;
        console.error(`[nhentai] ${i + 1}/${selected.length} page ${number}: exists, skipped`);
        continue;
      }
      const body = await downloadBinary(imageUrl(pageInfo.path), proxy);
      writeFileSync(file, body);
      saved += 1;
      console.error(`[nhentai] ${i + 1}/${selected.length} page ${number}: ${(body.length / 1024).toFixed(0)} KB`);
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }

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

    return [
      {
        id,
        title: detail?.title?.pretty || detail?.title?.english || '(untitled)',
        pages: selected.length,
        saved,
        skipped,
        dir: outDir,
      },
    ];
  },
});
