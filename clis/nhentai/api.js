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
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
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
    if (/^socks/i.test(value)) {
      throw new CommandExecutionError(
        'SOCKS proxies are not supported by the image downloader.',
        'Clash exposes an HTTP port alongside the SOCKS one: point --proxy at the mixed/HTTP port (e.g. http://127.0.0.1:7890).',
      );
    }
    return value.replace(/\/$/, '');
  }
  const first = value.split(';')[0].replace(/^[a-z]+=/i, '');
  return `http://${first}`;
}

/** NO_PROXY / no_proxy entries: "*", "host", ".suffix", "host:port". */
function noProxyEntries() {
  const raw = process.env.NO_PROXY || process.env.no_proxy || '';
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isProxyBypassed(url) {
  const entries = noProxyEntries();
  if (entries.length === 0) return false;
  if (entries.includes('*')) return true;
  let host = '';
  let port = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    port = u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const [hostPart, portPart] = entry.split(':');
    const hostMatches = hostPart === host || (hostPart.startsWith('.') && host.endsWith(hostPart)) || host.endsWith(`.${hostPart}`);
    if (!hostMatches) return false;
    return !portPart || portPart === port;
  });
}

/**
 * Proxy to use for one image URL: an explicit --proxy wins, otherwise the
 * detected one, unless NO_PROXY says this host must go direct.
 */
export function resolveProxyFor(url, explicit) {
  const chosen = String(explicit ?? '').trim() || detectProxy();
  if (!chosen) return null;
  const normalized = normalizeProxy(chosen);
  return isProxyBypassed(url) ? null : normalized;
}

function httpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseHttpResponse(buf) {
  if (!buf || buf.length === 0) {
    throw httpError('EMPTY_RESPONSE', 'empty response (connection closed before headers)');
  }
  const split = buf.indexOf('\r\n\r\n');
  if (split < 0) {
    const preview = buf.subarray(0, 80).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    throw httpError('MALFORMED_RESPONSE', `malformed HTTP response (no header terminator); first bytes: "${preview}"`);
  }
  const head = buf.subarray(0, split).toString('latin1');
  const lines = head.split('\r\n');
  const status = Number((lines[0] || '').split(' ')[1] || 0);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let body = buf.subarray(split + 4);
  const declared = Number(headers['content-length'] || 0);
  if ((headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
    body = decodeChunked(body);
  } else if (declared > 0) {
    if (body.length < declared) {
      throw httpError('TRUNCATED_BODY', `truncated body: got ${body.length} of ${declared} bytes`);
    }
    body = body.subarray(0, declared);
  }
  if (body.length === 0) {
    throw httpError('EMPTY_BODY', `empty body (HTTP ${status}, ${declared || 'no'} content-length declared)`);
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
        // Any bytes the proxy sent after the CONNECT headers already belong to
        // the TLS stream; hand them back before the socket is wrapped.
        const rest = handshake.subarray(split + 4);
        if (rest.length) raw.unshift(rest);

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

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'EMPTY_RESPONSE',
  'EMPTY_BODY',
  'TRUNCATED_BODY',
  'MALFORMED_RESPONSE',
]);

function isRetryable(error, status) {
  if (status === 404) return false;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (!error) return false;
  if (RETRYABLE_CODES.has(error.code)) return true;
  return /socket hang up|timed? ?out|ECONNRESET|EPIPE|empty response|truncated|malformed HTTP/i.test(String(error.message || error));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Download one binary asset.
 *
 * A single transient proxy hiccup must not fail a 148-page download, so the
 * attempts are generous and backed off exponentially (1s, 2s, 4s, 8s + jitter).
 * Each attempt tries the proxy first and then a direct connection.
 */
export async function downloadBinary(url, proxy, { retries = 4, timeoutMs = 30000 } = {}) {
  const candidates = proxy ? ['proxy', 'direct'] : ['direct'];
  const attempts = Math.max(1, Number(retries) || 1);
  const failures = [];
  const attemptLog = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const mode of candidates) {
      let status = 0;
      try {
        const res = mode === 'proxy' ? await requestViaProxy(url, proxy, timeoutMs) : await requestDirect(url, timeoutMs);
        status = res.status;
        if (status >= 200 && status < 300 && res.body?.length) return res.body;
        failures.push(`${mode}: HTTP ${status}`);
        attemptLog.push({ mode, message: `HTTP ${status}` });
        if (status === 404) {
          const notFound = new CommandExecutionError(`nhentai: image not found (HTTP 404) — ${url}`, 'The gallery may have been removed from the image CDN.');
          notFound.attempts = attemptLog;
          notFound.attemptCount = attemptLog.length;
          throw notFound;
        }
      } catch (error) {
        if (error instanceof CommandExecutionError) throw error;
        const message = String(error?.message || error);
        failures.push(`${mode}: ${message}`);
        attemptLog.push({ mode, message });
        if (!isRetryable(error, status)) {
          const fatal = classifyDownloadFailure(url, failures);
          fatal.attempts = attemptLog;
          fatal.attemptCount = attemptLog.length;
          throw fatal;
        }
      }
    }
    if (attempt + 1 < attempts) {
      const backoff = Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
      await sleep(backoff);
    }
  }
  const failure = classifyDownloadFailure(url, failures);
  failure.attempts = attemptLog;
  failure.attemptCount = attemptLog.length;
  throw failure;
}

function classifyDownloadFailure(url, failures) {
  const reasons = [...new Set(failures)];
  const hint = reasons.length ? reasons.join(' | ') : 'unknown error';
  return new CommandExecutionError(
    `nhentai: failed to download ${url}`,
    `${hint}. Retried automatically; if this repeats, check the proxy (--proxy http://127.0.0.1:7890) or NO_PROXY.`,
  );
}

const IMAGE_SIGNATURES = {
  '.jpg': [[0xff, 0xd8, 0xff]],
  '.jpeg': [[0xff, 0xd8, 0xff]],
  '.png': [[0x89, 0x50, 0x4e, 0x47]],
  '.gif': [[0x47, 0x49, 0x46, 0x38]],
  '.webp': [[0x52, 0x49, 0x46, 0x46]],
};

/** Reject HTML error pages and truncated files before they are written to disk. */
export function assertImageData(buffer, ext, url) {
  const key = String(ext || '').toLowerCase();
  const signatures = IMAGE_SIGNATURES[key];
  if (!signatures) return;
  const matches = signatures.some((sig) => sig.every((byte, i) => buffer[i] === byte));
  if (!matches) {
    const head = buffer.subarray(0, 12).toString('hex');
    throw new CommandExecutionError(
      `nhentai: ${url} did not return ${key} image data`,
      `First bytes: ${head}. This usually means the proxy/CDN served an HTML error page.`,
    );
  }
  if (key === '.webp' && buffer.subarray(8, 12).toString('latin1') !== 'WEBP') {
    throw new CommandExecutionError(`nhentai: ${url} is not a valid WebP file`, 'RIFF header matched but the WEBP marker is missing.');
  }
}

/** Write through a .part file so an interrupted download never leaves a broken image. */
export function saveBinaryAtomic(filePath, buffer) {
  mkdirSync(dirname(filePath), { recursive: true });
  const part = `${filePath}.part`;
  writeFileSync(part, buffer);
  renameSync(part, filePath);
}

/** Atomic JSON write: a killed process must never leave half a JSON document. */
export function writeJsonAtomic(filePath, value, spacing = 2) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, spacing), 'utf8');
  renameSync(tmp, filePath);
}

export function writeBinary(filePath, buffer) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buffer);
}

export { existsSync, mkdirSync, writeFileSync };
