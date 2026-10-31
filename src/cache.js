import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = 3;

export function cacheFilePath(outDir) {
  return path.join(outDir, '.pixelpress-cache.json');
}

export async function loadCache(outDir, fingerprint) {
  const file = cacheFilePath(outDir);
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data.version !== VERSION || data.fingerprint !== fingerprint) {
      return { file, fingerprint, files: {} };
    }
    if (!data.files || typeof data.files !== 'object' || Array.isArray(data.files)) {
      return { file, fingerprint, files: {} };
    }
    return { file, fingerprint, files: data.files };
  } catch {
    return { file, fingerprint, files: {} };
  }
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
  const temporary = `${cache.file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(payload));
  await fs.rename(temporary, cache.file);
}
