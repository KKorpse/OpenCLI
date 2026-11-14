import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { nhGet, listFrom, TAG_TYPES } from './api.js';

cli({
  site: 'nhentai',
  name: 'tags',
  access: 'read',
  description: 'Browse nhentai tags (tag, artist, character, parody, group, language, category)',
  domain: 'nhentai.net',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'type', default: 'tag', choices: TAG_TYPES, help: 'tag_type' },
    { name: 'page', type: 'int', default: 1, help: 'Result page (25 per page)' },
    { name: 'limit', type: 'int', default: 20, help: 'Max rows to print' },
    { name: 'sort', default: 'popular', choices: ['popular', 'name'], help: 'popular | name' },
  ],
  columns: ['rank', 'id', 'name', 'type', 'count', 'slug'],
  func: async (page, kwargs) => {
    const type = String(kwargs.type ?? 'tag');
    const pageNo = Number(kwargs.page) || 1;
    const limit = Number(kwargs.limit) || 20;
    const sort = String(kwargs.sort ?? 'popular');
    const payload = await nhGet(
      page,
      `/api/v2/tags/${encodeURIComponent(type)}?sort=${encodeURIComponent(sort)}&page=${pageNo}`,
      `${type} tags`,
    );
    const items = listFrom(payload).slice(0, limit);
    if (items.length === 0) throw new EmptyResultError(`nhentai: no ${type} tags returned.`, 'Check --type; valid values: ' + TAG_TYPES.join(', '));
    return items.map((tag, index) => ({
      rank: index + 1,
      id: tag.id,
      name: tag.name,
      type: tag.type,
      count: tag.count,
      slug: tag.slug,
    }));
  },
});
