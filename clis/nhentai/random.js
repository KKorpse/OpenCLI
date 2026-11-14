import { cli, Strategy } from '@jackwener/opencli/registry';
import { nhGet, formatDetail } from './api.js';

cli({
  site: 'nhentai',
  name: 'random',
  access: 'read',
  description: 'A random nhentai gallery',
  domain: 'nhentai.net',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [],
  columns: ['id', 'title', 'pages', 'favorites', 'uploaded', 'artists', 'tags', 'languages', 'url'],
  func: async (page) => {
    const picked = await nhGet(page, '/api/v2/galleries/random', 'random gallery');
    const id = picked?.id;
    if (!id) throw new Error('nhentai: random endpoint returned no id.');
    const detail = await nhGet(page, `/api/v2/galleries/${id}`, `gallery ${id}`);
    return [formatDetail(detail)];
  },
});
