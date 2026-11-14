import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { nhGet, formatListItem, listFrom } from './api.js';

cli({
  site: 'nhentai',
  name: 'latest',
  access: 'read',
  description: 'Newest nhentai galleries',
  domain: 'nhentai.net',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'page', type: 'int', default: 1, help: 'Result page (25 per page)' },
    { name: 'limit', type: 'int', default: 20, help: 'Max rows to print' },
  ],
  columns: ['rank', 'id', 'title', 'pages', 'favorites', 'thumbnail', 'url'],
  func: async (page, kwargs) => {
    const pageNo = Number(kwargs.page) || 1;
    const limit = Number(kwargs.limit) || 20;
    const payload = await nhGet(page, `/api/v2/galleries?page=${pageNo}`, 'latest galleries');
    const items = listFrom(payload).slice(0, limit);
    if (items.length === 0) throw new EmptyResultError('nhentai: no galleries on this page.', 'Try a smaller --page.');
    return items.map(formatListItem);
  },
});
