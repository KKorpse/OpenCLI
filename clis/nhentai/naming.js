/**
 * Folder naming + on-disk identity for galleries.
 *
 * The directory is named after the gallery title (sanitised for Windows), and
 * the directory's identity is the `<id>.json` file inside it. Renaming or
 * retitling never changes that file, so planning always keys off the id file,
 * never off the directory path.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const ID_FILE_RE = /^(\d+)\.(json|txt)$/i;
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const MAX_NAME_LENGTH = 90;
export const FOLDER_MODES = ['title', 'id', 'title-id'];

export function sanitizeTitle(title) {
  let name = String(title ?? '')
    .replace(ILLEGAL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .trim();

  if (!name) name = 'untitled';
  name = name.slice(0, MAX_NAME_LENGTH).trim().replace(/\.+$/, '');
  if (!name) name = 'untitled';
  // Win32 reserved device names are unusable as directory names.
  if (RESERVED_NAMES.test(name)) name = `_${name}`;
  return name;
}

export function folderNameFor({ mode = 'title', id, title }) {
  const safeTitle = sanitizeTitle(title);
  if (mode === 'id') return String(id);
  if (mode === 'title-id') return `${safeTitle}__${id}`;
  return safeTitle;
}

/** Path of the identity file for `id` inside `dir`, or null. */
export function findIdFile(dir, id) {
  if (!existsSync(dir)) return null;
  const wanted = `${id}.json`;
  const wantedTxt = `${id}.txt`;
  try {
    for (const name of readdirSync(dir)) {
      if (name === wanted || name === wantedTxt) return join(dir, name);
      const match = ID_FILE_RE.exec(name);
      if (match && match[1] === String(id)) return join(dir, name);
    }
  } catch { /* unreadable directory */ }
  return null;
}

/** One-level scan of `<outDir>/*` for a directory that already holds this id. */
export function findExistingGalleryDir(outDir, id) {
  if (!existsSync(outDir)) return null;
  try {
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(outDir, entry.name);
      if (findIdFile(dir, id)) return dir;
    }
  } catch { /* unreadable output root */ }
  return null;
}

/**
 * Directory to write this gallery into.
 *
 * An existing directory for the id always wins, so resume never creates a second
 * copy. Otherwise the deterministic title folder is used, and only a genuine
 * collision (that folder belongs to a different id) appends `__<id>`.
 */
export function resolveGalleryDir(outDir, { id, title, mode = 'title', dir }) {
  if (dir) return resolve(dir);
  const root = resolve(outDir);
  const existing = findExistingGalleryDir(root, id);
  if (existing) return existing;

  const base = folderNameFor({ mode, id, title });
  const candidate = join(root, base);
  if (!existsSync(candidate)) return candidate;
  if (findIdFile(candidate, id)) return candidate;
  return join(root, `${base}__${id}`);
}

export function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

export function metadataPages(meta) {
  const value = Number(meta?.raw?.num_pages) || Number(meta?.gallery?.pages) || Number(meta?.num_pages);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export { basename, join };
