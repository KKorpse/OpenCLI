import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { nhGet, formatListItem, listFrom } from './api.js';

cli({
  site: 'nhentai',
  name: 'popular',
  access: 'read',
  description: 'Currently popular nhentai galleries',
  domain: 'nhentai.net',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: 'limit', type: 'int', default: 5, help: 'Max rows to print' }],
  columns: ['rank', 'id', 'title', 'pages', 'favorites', 'thumbnail', 'url'],
  func: async (page, kwargs) => {
    const limit = Number(kwargs.limit) || 5;
    const payload = await nhGet(page, '/api/v2/galleries/popular', 'popular galleries');
    const items = listFrom(payload).slice(0, limit);
    if (items.length === 0) throw new EmptyResultError('nhentai: popular list is empty right now.', 'Retry later.');
    return items.map(formatListItem);
  },
});
