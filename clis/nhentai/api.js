/**
 * nhentai adapter shared helpers.
 *
 * Why everything goes through the browser: nhentai.net sits behind Cloudflare and
 * answers plain Node requests with 403. Requests issued from inside a page on the
 * same origin carry the browser's clearance cookie and succeed.
 *
 * Why downloads do not: image bytes live on i.nhentai.net, which serves plain
 * HTTPS. Node can fetch those directly, but on machines that reach the internet
 * through a system proxy, Node ignores the WinINET proxy — so the download helper
 * reads the proxy itself and tunnels through it with CONNECT.
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

export const ORIGIN = 'https://nhentai.net';
export const IMAGE_ORIGIN = 'https://i.nhentai.net';
export const THUMB_ORIGIN = 'https://t.nhentai.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const SORTS = ['date', 'popular', 'popular-today', 'popular-week', 'popular-month'];
export const SEARCH_SORTS = SORTS;
export const TAG_TYPES = ['tag', 'category', 'parody', 'character', 'artist', 'group', 'language'];

let originReady = false;

/** Accepts a bare id, a /g/<id>/ path, or a full gallery URL. */
export function parseGalleryId(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new CommandExecutionError('A gallery id or URL is required.');
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = /\/g\/(\d+)/.exec(raw) || /gallery\/(\d+)/.exec(raw) || /(\d{1,9})/.exec(raw);
  if (!m) throw new CommandExecutionError(`Cannot read a gallery id from "${raw}".`, 'Pass the numeric id (e.g. 364461) or a https://nhentai.net/g/<id>/ URL.');
  return Number(m[1]);
}

export function galleryUrl(id) {
  return `${ORIGIN}/g/${id}/`;
}

export function favoritesUrl(pageNo) {
  return `${ORIGIN}/user/favorites/?page=${pageNo}`;
}

/**
 * Scrape the server-rendered favourites page.
 *
 * The public API v2 answers `Authorization: Key <api_key>` only, and the browser
 * session cookie is not accepted there — but the site's own favourites page is
 * server-rendered with the cookie, so its DOM is the reliable source.
 */
export async function collectFavoriteCards(page) {
  return page.evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('.gallery')).map((el) => {
      const link = el.querySelector('a.cover[href*="/g/"]') || el.querySelector('a[href*="/g/"]');
      const img = el.querySelector('img');
      const caption = el.querySelector('.caption');
      const href = link ? link.getAttribute('href') : '';
      const match = /\\/g\\/(\\d+)\\//.exec(href || '');
      return {
        id: match ? Number(match[1]) : 0,
        title: (caption && caption.textContent) || (img && img.getAttribute('alt')) || '',
        thumb: (img && (img.getAttribute('src') || img.getAttribute('data-src'))) || '',
      };
    }).filter((card) => card.id > 0);
    return {
      cards,
      bodyText: document.body ? document.body.innerText.slice(0, 400) : '',
      hrefs: Array.from(document.querySelectorAll('a[href*="page="]')).map((a) => a.getAttribute('href') || ''),
    };
  })()`);
}

export function imageUrl(path) {
  if (!path) return '';
  return path.startsWith('http') ? path : `${IMAGE_ORIGIN}/${String(path).replace(/^\/+/, '')}`;
}

export function thumbUrl(path) {
  if (!path) return '';
  return path.startsWith('http') ? path : `${THUMB_ORIGIN}/${String(path).replace(/^\/+/, '')}`;
}

/** Make sure the automation tab is on nhentai.net so same-origin fetch carries cookies. */
export async function ensureOrigin(page) {
  if (originReady) return;
  const current = typeof page.getCurrentUrl === 'function' ? await page.getCurrentUrl().catch(() => null) : null;
  if (!current || !String(current).startsWith(ORIGIN)) {
    try {
      await page.goto(`${ORIGIN}/`);
    } catch (error) {
      throw new CommandExecutionError(
        'nhentai: the browser could not load nhentai.net.',
        `${String(error?.message || error).slice(0, 160)}. Check the proxy/VPN, wait a few minutes if this IP has been rate limited, then retry.`,
      );
    }
  }
  originReady = true;
}

/**
 * Describe what the current tab really shows. Chrome renders network failures as
 * a chrome-error:// document, which otherwise looks like "the page has no items".
 */
export async function inspectPage(page) {
  const raw = await page.evaluate(
    `JSON.stringify({
      url: location.href,
      title: document.title,
      cards: document.querySelectorAll('.gallery').length,
      text: (document.body ? document.body.innerText : '').slice(0, 400),
    })`,
  );
  const state = JSON.parse(raw);
  state.connectionError = /^chrome-error:/i.test(state.url) || /ERR_(CONNECTION|TIMED_OUT|TUNNEL|PROXY|SSL)/i.test(state.text);
  return state;
}

/**
 * GET a nhentai API path from inside the page. Returns parsed JSON.
 * Throws typed errors that name the failing call instead of returning empty data.
 */
export async function nhGet(page, path, label = path) {
  await ensureOrigin(page);
  const url = path.startsWith('http') ? path : `${ORIGIN}${path}`;
  const script = `(async () => {
    const r = await fetch(${JSON.stringify(url)}, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    return { status: r.status, text: await r.text() };
  })()`;

  // A tab that lost its Cloudflare clearance (or was recycled by the bridge)
  // throws "Failed to fetch" from inside the page rather than returning a status.
  // Re-navigate once and retry before reporting it as a site failure.
  let res;
  try {
    res = await page.evaluate(script);
  } catch (error) {
    const message = String(error?.message || error);
    if (!/Failed to fetch|NetworkError|context (was )?(destroyed|closed)/i.test(message)) throw error;
    originReady = false;
    await page.goto(`${ORIGIN}/`);
    res = await page.evaluate(script);
  }
  const status = Number(res?.status ?? 0);
  const text = String(res?.text ?? '');

  if (status === 404) {
    throw new CommandExecutionError(`nhentai: ${label} — not found (HTTP 404).`, 'Check the gallery id or tag slug, then retry.');
  }
  if (status === 429) {
    throw new CommandExecutionError(`nhentai: ${label} — rate limited (HTTP 429).`, 'Anonymous requests are limited to about 10 per minute. Wait a little and retry.');
  }
  if (status === 403) {
    throw new CommandExecutionError(
      `nhentai: ${label} — blocked (HTTP 403).`,
      'Open https://nhentai.net/ in the same browser profile, clear any Cloudflare check, then retry.',
    );
  }
  if (status < 200 || status >= 300) {
    throw new CommandExecutionError(`nhentai: ${label} — HTTP ${status}.`, text.slice(0, 200));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CommandExecutionError(`nhentai: ${label} — response was not JSON.`, text.slice(0, 160));
  }
}

export function emptyResult(what) {
  return new EmptyResultError(`nhentai: no ${what} found.`, 'Broaden the query or drop the sort filter.');
}

/** Map a GalleryListItem (search / latest / tagged / related) into one output row. */
export function formatListItem(item, index) {
  const title = item.english_title || item.japanese_title || '(untitled)';
  return {
    rank: index + 1,
    id: item.id,
    title: String(title).replace(/\s+/g, ' ').trim(),
    pages: item.num_pages ?? null,
    favorites: item.num_favorites ?? null,
    thumbnail: thumbUrl(item.thumbnail),
    url: galleryUrl(item.id),
  };
}

export function listFrom(payload, wrapKey) {
  if (Array.isArray(payload)) return payload;
  const list = wrapKey ? payload?.[wrapKey] : payload?.result ?? payload?.data;
  return Array.isArray(list) ? list : [];
}

function namesOf(tags, type) {
  return tags.filter((t) => t && t.type === type).map((t) => t.name).filter(Boolean);
}

/** Full metadata view of a gallery detail payload (<= 12 top-level keys). */
export function formatDetail(detail, { full = false } = {}) {
  const tags = Array.isArray(detail?.tags) ? detail.tags : [];
  const row = {
    id: detail.id,
    title: detail?.title?.pretty || detail?.title?.english || '(untitled)',
    pages: detail.num_pages ?? null,
    favorites: detail.num_favorites ?? null,
    uploaded: detail.upload_date ? new Date(detail.upload_date * 1000).toISOString().slice(0, 10) : '',
    artists: namesOf(tags, 'artist').join(', '),
    groups: namesOf(tags, 'group').join(', '),
    parodies: namesOf(tags, 'parody').join(', '),
    characters: namesOf(tags, 'character').join(', '),
    tags: namesOf(tags, 'tag').join(', '),
    languages: namesOf(tags, 'language').join(', '),
    url: galleryUrl(detail.id),
  };
  if (full) {
    row.categories = namesOf(tags, 'category').join(', ');
    row.english = detail?.title?.english || '';
    row.scanlator = detail.scanlator || '';
    row.cover = thumbUrl(detail?.cover?.path);
  }
  return row;
}

/** `1-5,8` -> [1,2,3,4,5,8]; empty spec means "all pages". */
export function parsePageRange(spec, total) {
  const text = String(spec ?? '').trim();
  const all = Array.from({ length: total }, (_, i) => i + 1);
  if (!text) return all;
  const picked = new Set();
  for (const part of text.split(',')) {
    const chunk = part.trim();
    if (!chunk) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(chunk);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) picked.add(i);
    } else if (/^\d+$/.test(chunk)) {
      picked.add(Number(chunk));
    } else {
      throw new CommandExecutionError(`Cannot parse --pages value "${spec}".`, 'Use forms like 3, "1-5", or "1-3,7".');
    }
  }
  const valid = [...picked].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  if (valid.length === 0) throw new CommandExecutionError(`--pages ${spec} selects nothing (gallery has ${total} pages).`);
  return valid;
}

/** Environment proxy first, then the Windows system proxy; null when none is configured. */
export function detectProxy() {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = process.env[key];
    if (value && value.trim()) return normalizeProxy(value.trim());
  }
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 },
      );
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
      const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out);
      if (enabled && server) return normalizeProxy(server[1]);
    } catch {
      /* no readable system proxy */
    }
  }
  return null;
}

function normalizeProxy(value) {
  if (/^[a-z0-9]+:\/\//i.test(value)) {
    if (/^socks/i.test(value)) throw new CommandExecutionError('SOCKS proxies are not supported by the downloader.', 'Point --proxy at the HTTP/mixed port (e.g. http://127.0.0.1:7890).');
    return value.replace(/\/$/, '');
  }
  const first = value.split(';')[0].replace(/^[a-z]+=/i, '');
  return `http://${first}`;
}

function parseHttpResponse(buf) {
  const split = buf.indexOf('\r\n\r\n');
  if (split < 0) throw new Error('malformed HTTP response from image server');
  const head = buf.subarray(0, split).toString('latin1');
  const lines = head.split('\r\n');
  const status = Number((lines[0] || '').split(' ')[1] || 0);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let body = buf.subarray(split + 4);
  if ((headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
    body = decodeChunked(body);
  } else if (headers['content-length']) {
    body = body.subarray(0, Number(headers['content-length']));
  }
  return { status, headers, body };
}

function decodeChunked(buf) {
  const parts = [];
  let offset = 0;
  while (offset < buf.length) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = parseInt(buf.subarray(offset, lineEnd).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    parts.push(buf.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(parts);
}

function requestDirect(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { 'user-agent': UA, referer: `${ORIGIN}/`, accept: '*/*', 'accept-encoding': 'identity' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('image request timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Tunnel one HTTPS GET through an HTTP proxy (CONNECT + TLS).
 *
 * The tunnel is opened with a raw net.Socket on purpose: handing an
 * http.request() CONNECT socket to tls.connect() makes Node tear the socket
 * down mid-handshake (ECONNRESET), while a socket this code owns upgrades fine.
 */
function requestViaProxy(url, proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') {
      reject(new Error('only HTTPS image URLs can be tunnelled through a proxy'));
      return;
    }
    const p = new URL(proxy);
    const target = `${u.hostname}:${u.port || 443}`;

    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const fail = (error) => {
      settle(reject, error instanceof Error ? error : new Error(String(error)));
    };

    const raw = net.connect({ host: p.hostname, port: Number(p.port || 80) });
    raw.setTimeout(timeoutMs, () => fail(new Error('proxy connection timed out')));
    raw.on('error', fail);
    raw.once('connect', () => {
      raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n\r\n`);

      let handshake = Buffer.alloc(0);
      const onProxyData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const split = handshake.indexOf('\r\n\r\n');
        if (split < 0) return;
        raw.removeListener('data', onProxyData);
        raw.pause();

        const status = Number((handshake.subarray(0, split).toString('latin1').split('\r\n')[0] || '').split(' ')[1] || 0);
        if (status !== 200) {
          fail(new Error(`proxy refused CONNECT (HTTP ${status})`));
          return;
        }

        const secure = tls.connect({ socket: raw, servername: u.hostname }, () => {
          secure.write(
            `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
              `Host: ${u.hostname}\r\n` +
              `User-Agent: ${UA}\r\n` +
              `Referer: ${ORIGIN}/\r\n` +
              `Accept: */*\r\n` +
              `Accept-Encoding: identity\r\n` +
              `Connection: close\r\n\r\n`,
          );
        });
        secure.setTimeout(timeoutMs, () => secure.destroy(new Error('image request timed out (proxy)')));
        secure.on('error', fail);

        const chunks = [];
        const finish = () => {
          if (settled) return;
          try {
            settle(resolve, parseHttpResponse(Buffer.concat(chunks)));
          } catch (error) {
            fail(error);
          }
        };
        secure.on('data', (c) => chunks.push(c));
        secure.on('end', finish);
        secure.on('close', finish);
      };
      raw.on('data', onProxyData);
    });
  });
}

/**
 * Download one binary asset. Tries the proxy first when one is configured,
 * then falls back to a direct connection.
 */
export async function downloadBinary(url, proxy, { attempts = 2, timeoutMs = 30000 } = {}) {
  const candidates = proxy ? ['proxy', 'direct'] : ['direct'];
  const failures = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const mode of candidates) {
      try {
        const res = mode === 'proxy' ? await requestViaProxy(url, proxy, timeoutMs) : await requestDirect(url, timeoutMs);
        if (res.status >= 200 && res.status < 300 && res.body?.length) return res.body;
        failures.push(`${mode}: HTTP ${res.status}`);
        if (res.status === 404) {
          throw new CommandExecutionError(`nhentai: image not found (HTTP 404) — ${url}`, 'The gallery may have been removed from the image CDN.');
        }
      } catch (error) {
        if (error instanceof CommandExecutionError) throw error;
        const message = String(error?.message || error);
        failures.push(`${mode}: ${message}`);
      }
    }
    if (failures.length && attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  const hint = failures.length ? [...new Set(failures)].join(' | ') : 'unknown error';
  throw new CommandExecutionError(
    `nhentai: failed to download ${url}`,
    `${hint}. If you are behind a proxy, pass --proxy http://127.0.0.1:7890.`,
  );
}

export function writeBinary(filePath, buffer) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buffer);
}

export { existsSync, mkdirSync, writeFileSync };
