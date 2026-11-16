import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeFileAtomic } from './atomic.js';

const VERSION = 3;

export function cacheFilePath(cacheDir, outDir) {
  const key = createHash('sha256').update(path.resolve(outDir)).digest('hex').slice(0, 12);
  return path.join(cacheDir, `cache-${key}.json`);
}

export async function loadCache(cacheDir, outDir, fingerprint) {
  const file = cacheFilePath(cacheDir, outDir);
  const legacyFile = path.join(outDir, '.pixelpress-cache.json');

  let data = await readPack(file);
  let legacy = null;
  if (!usable(data)) {
    data = await readPack(legacyFile);
    if (usable(data)) legacy = legacyFile;
    else data = null;
  } else {
    // Clean up a leftover pre-0.4 cache on the next save.
    try {
      await fs.access(legacyFile);
      legacy = legacyFile;
    } catch {
      // no legacy cache
    }
  }

  if (!data) {
    return { file, legacyFile: null, fingerprint, files: {}, previousFiles: {} };
  }

  return {
    file,
    legacyFile: legacy,
    fingerprint,
    // Use entries for skipping only when the option fingerprint matches.
    files: data.fingerprint === fingerprint ? data.files : {},
    // Keep every known output for --prune even after an option change.
    previousFiles: data.files,
  };
}

export async function saveCache(cache, entries) {
  if (!cache) return;
  const payload = {
    version: VERSION,
    fingerprint: cache.fingerprint,
    generatedAt: new Date().toISOString(),
    files: entries,
  };
  await fs.mkdir(path.dirname(cache.file), { recursive: true });
  await writeFileAtomic(cache.file, `${JSON.stringify(payload)}\n`);
  if (cache.legacyFile) await fs.rm(cache.legacyFile, { force: true });
}

async function readPack(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function usable(data) {
  return Boolean(
    data
    && data.version === VERSION
    && data.files
    && typeof data.files === 'object'
    && !Array.isArray(data.files),
  );
}
