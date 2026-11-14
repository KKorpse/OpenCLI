import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { nhGet, formatListItem, listFrom, TAG_TYPES } from './api.js';

cli({
  site: 'nhentai',
  name: 'tag',
  access: 'read',
  description: 'List galleries carrying one nhentai tag slug (e.g. sole-female, english, koari)',
  domain: 'nhentai.net',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'slug', positional: true, required: true, help: 'Tag slug, e.g. sole-female' },
    { name: 'type', default: 'tag', choices: TAG_TYPES, help: 'tag_type the slug belongs to' },
    { name: 'page', type: 'int', default: 1, help: 'Result page (25 per page)' },
    { name: 'limit', type: 'int', default: 20, help: 'Max rows to print' },
    { name: 'sort', default: 'date', choices: ['date', 'popular', 'popular-today', 'popular-week', 'popular-month'], help: 'Sort order' },
  ],
  columns: ['rank', 'id', 'title', 'pages', 'favorites', 'thumbnail', 'url'],
  func: async (page, kwargs) => {
    const slug = String(kwargs.slug ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!slug) throw new EmptyResultError('A tag slug is required.');
    const type = String(kwargs.type ?? 'tag');
    const pageNo = Number(kwargs.page) || 1;
    const limit = Number(kwargs.limit) || 20;
    const sort = String(kwargs.sort ?? 'date');

    const tag = await nhGet(page, `/api/v2/tags/${encodeURIComponent(type)}/${encodeURIComponent(slug)}`, `${type} "${slug}"`);
    if (!tag?.id) throw new EmptyResultError(`nhentai: ${type} "${slug}" has no id.`, 'Check the slug with `opencli nhentai tags --type ' + type + '`.');

    const payload = await nhGet(
      page,
      `/api/v2/galleries/tagged?tag_id=${tag.id}&sort=${encodeURIComponent(sort)}&page=${pageNo}`,
      `${type} "${slug}" galleries`,
    );
    const items = listFrom(payload).slice(0, limit);
    if (items.length === 0) throw new EmptyResultError(`nhentai: no galleries for ${type} "${slug}" on page ${pageNo}.`, 'Try --sort popular or a smaller --page.');
    return items.map(formatListItem);
  },
});
