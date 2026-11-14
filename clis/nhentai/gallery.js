import { cli, Strategy } from '@jackwener/opencli/registry';
import { nhGet, parseGalleryId, formatDetail } from './api.js';

cli({
  site: 'nhentai',
  name: 'gallery',
  access: 'read',
  description: 'Show one nhentai gallery: title, artists, tags, page count, favorites',
  domain: 'nhentai.net',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'target', positional: true, required: true, help: 'Gallery id or https://nhentai.net/g/<id>/ URL' },
    { name: 'full', type: 'bool', default: false, help: 'Also include category, english title, scanlator and cover' },
  ],
  columns: ['id', 'title', 'pages', 'favorites', 'uploaded', 'artists', 'groups', 'parodies', 'characters', 'tags', 'languages', 'url'],
  func: async (page, kwargs) => {
    const id = parseGalleryId(kwargs.target);
    const detail = await nhGet(page, `/api/v2/galleries/${id}`, `gallery ${id}`);
    return [formatDetail(detail, { full: Boolean(kwargs.full) })];
  },
});
