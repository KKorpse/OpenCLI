import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { nhGet, formatListItem, listFrom, SEARCH_SORTS } from './api.js';

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The nhentai query language needs embedded double quotes (`tag:"sole female"`),
 * and shells mangle those (Windows PowerShell drops the inner quotes, so the
 * value arrives as two argv entries). Every filter is therefore also offered as
 * its own flag, and the adapter assembles the query string itself.
 */
cli({
  site: 'nhentai',
  name: 'search',
  access: 'read',
  description: 'Search nhentai galleries (free text plus tag/artist/language/pages/favorites filters)',
  domain: 'nhentai.net',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'query', positional: true, required: false, help: 'Free-text keywords; optional when filters are used' },
    { name: 'tag', default: '', help: 'Comma-separated tags to require, e.g. "sole female,big breasts"' },
    { name: 'exclude-tag', default: '', help: 'Comma-separated tags to exclude' },
    { name: 'artist', default: '', help: 'Artist name (comma-separated for several)' },
    { name: 'language', default: '', help: 'Language, e.g. english / chinese / japanese' },
    { name: 'pages', default: '', help: 'Page-count filter, e.g. ">10" or "10-30"' },
    { name: 'favorites', default: '', help: 'Favourite-count filter, e.g. ">=100"' },
    { name: 'uploaded', default: '', help: 'Upload window, e.g. "<7d" or ">1m"' },
    { name: 'page', type: 'int', default: 1, help: 'Result page (25 per page)' },
    { name: 'limit', type: 'int', default: 20, help: 'Max rows to print' },
    { name: 'sort', default: 'date', choices: SEARCH_SORTS, help: 'date | popular | popular-today | popular-week | popular-month' },
  ],
  columns: ['rank', 'id', 'title', 'pages', 'favorites', 'thumbnail', 'url'],
  func: async (page, kwargs) => {
    const parts = [];
    const freeText = String(kwargs.query ?? '').trim();
    if (freeText) parts.push(freeText);
    for (const tag of splitList(kwargs.tag)) parts.push(`tag:"${tag}"`);
    for (const tag of splitList(kwargs['exclude-tag'])) parts.push(`-tag:"${tag}"`);
    for (const artist of splitList(kwargs.artist)) parts.push(`artist:"${artist}"`);
    if (kwargs.language) parts.push(`language:${String(kwargs.language).trim()}`);
    if (kwargs.pages) parts.push(`pages:${String(kwargs.pages).trim()}`);
    if (kwargs.favorites) parts.push(`favorites:${String(kwargs.favorites).trim()}`);
    if (kwargs.uploaded) parts.push(`uploaded:${String(kwargs.uploaded).trim()}`);

    const composed = parts.join(' ');
    if (!composed) {
      throw new ArgumentError(
        'Nothing to search for.',
        'Pass keywords ("big breasts") or a filter (--tag "sole female", --language english, --artist koari).',
      );
    }

    const pageNo = Number(kwargs.page) || 1;
    const limit = Number(kwargs.limit) || 20;
    const sort = String(kwargs.sort ?? 'date');
    const payload = await nhGet(
      page,
      `/api/v2/search?query=${encodeURIComponent(composed)}&sort=${encodeURIComponent(sort)}&page=${pageNo}`,
      `search "${composed}"`,
    );
    const items = listFrom(payload).slice(0, limit);
    if (items.length === 0) {
      throw new EmptyResultError(`nhentai: no galleries matched "${composed}" (page ${pageNo}).`, 'Drop a filter or try --sort popular.');
    }
    return items.map(formatListItem);
  },
});
