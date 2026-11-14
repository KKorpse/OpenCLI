import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { nhGet, formatListItem, listFrom, parseGalleryId } from './api.js';

cli({
  site: 'nhentai',
  name: 'related',
  access: 'read',
  description: 'Galleries related to a given nhentai gallery',
  domain: 'nhentai.net',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'target', positional: true, required: true, help: 'Gallery id or URL' },
    { name: 'limit', type: 'int', default: 10, help: 'Max rows to print' },
  ],
  columns: ['rank', 'id', 'title', 'pages', 'favorites', 'thumbnail', 'url'],
  func: async (page, kwargs) => {
    const id = parseGalleryId(kwargs.target);
    const limit = Number(kwargs.limit) || 10;
    const payload = await nhGet(page, `/api/v2/galleries/${id}/related`, `related to ${id}`);
    const items = listFrom(payload).slice(0, limit);
    if (items.length === 0) throw new EmptyResultError(`nhentai: nothing is related to gallery ${id}.`, 'The gallery may be too niche or newly uploaded.');
    return items.map(formatListItem);
  },
});
