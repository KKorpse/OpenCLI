import { cli, Strategy } from '@jackwener/opencli/registry';
import { downloadGallery } from './download-core.js';

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
    { name: 'folder-name', default: 'title', choices: ['title', 'id', 'title-id'], help: 'Folder naming: sanitised title (default), id, or title__id' },
    { name: 'proxy', default: '', help: 'HTTP proxy for image downloads; auto-detected from env / Windows settings' },
    { name: 'timeout', type: 'int', default: 900, help: 'Seconds before this command gives up (default 900)' },
    { name: 'retries', type: 'int', default: 4, help: 'Attempts per image with exponential backoff' },
    { name: 'concurrency', type: 'int', default: 3, help: 'Parallel image downloads (1-8)' },
    { name: 'continue-on-error', type: 'bool', default: true, help: 'Keep going when a page fails; false aborts on first failure' },
    { name: 'max-failures', type: 'int', default: 10, help: 'Stop scheduling new pages after this many failures' },
    { name: 'overwrite', type: 'bool', default: false, help: 'Re-download files that already exist' },
    { name: 'delay', type: 'int', default: 120, help: 'Milliseconds to wait between images' },
  ],
  columns: ['id', 'title', 'pages', 'saved', 'skipped', 'failed_count', 'failed', 'folder', 'dir'],
  func: async (page, kwargs) => {
    const result = await downloadGallery(page, {
      target: kwargs.target,
      output: kwargs.output,
      pages: kwargs.pages,
      folderName: kwargs['folder-name'],
      proxy: kwargs.proxy,
      retries: kwargs.retries,
      concurrency: kwargs.concurrency,
      continueOnError: kwargs['continue-on-error'] !== undefined ? Boolean(kwargs['continue-on-error']) : true,
      maxFailures: kwargs['max-failures'],
      overwrite: kwargs.overwrite,
      delay: kwargs.delay,
    });

    if (result.failed.length) {
      console.error(`[nhentai] ${result.failed.length} page(s) failed: ${result.failed.map((f) => f.number).join(', ')}`);
      // Partial success: keep the JSON payload, but signal a non-zero status.
      process.exitCode = 2;
    }

    return [
      {
        id: result.id,
        title: result.title,
        pages: result.selectedCount,
        saved: result.saved.length,
        skipped: result.skipped.length,
        failed_count: result.failed.length,
        failed: result.failed.map((f) => f.number),
        folder: result.folder,
        dir: result.dir,
      },
    ];
  },
});
