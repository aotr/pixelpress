import { watch as fsWatch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Watch one or more roots for changes. Uses recursive fs.watch where the
 * platform supports it. Otherwise watches each directory and refreshes the
 * watcher set when directories are created or removed.
 */
export async function createWatcher({ roots, outDir, onChange, onError, forceFallback = false }) {
  if (!forceFallback) {
    const recursive = [];
    try {
      for (const root of roots) {
        const watcher = fsWatch(root, { recursive: true }, (eventType, filename) => {
          const changed = filename ? path.resolve(root, String(filename)) : root;
          onChange(changed, eventType);
        });
        watcher.on('error', (error) => onError?.(error));
        recursive.push(watcher);
      }
      return {
        fallback: false,
        close() {
          for (const watcher of recursive) watcher.close();
        },
      };
    } catch (error) {
      for (const watcher of recursive) watcher.close();
      if (error.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw error;
    }
  }

  const watchers = new Map();
  let closed = false;
  let refreshing = false;
  let refreshTimer = null;

  const watchDirectory = (directory) => {
    if (closed || watchers.has(directory)) return;
    try {
      const watcher = fsWatch(directory, { persistent: true }, (eventType, filename) => {
        if (closed) return;
        const changed = filename ? path.resolve(directory, String(filename)) : directory;
        if (eventType === 'rename') scheduleRefresh();
        onChange(changed, eventType);
      });
      watcher.on('error', (error) => onError?.(error));
      watchers.set(directory, watcher);
    } catch (error) {
      if (error.code !== 'ENOENT') onError?.(error);
    }
  };

  const collectDirectories = async (directory, found, seen) => {
    if (closed) return;
    if (directory === outDir || isInside(outDir, directory)) return;
    const real = await fs.realpath(directory).catch(() => path.resolve(directory));
    if (seen.has(real)) return;
    seen.add(real);
    found.add(directory);

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await collectDirectories(path.join(directory, entry.name), found, seen);
    }
  };

  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      const found = new Set();
      const seen = new Set();
      for (const root of roots) await collectDirectories(root, found, seen);

      for (const [directory, watcher] of watchers) {
        if (!found.has(directory)) {
          watcher.close();
          watchers.delete(directory);
        }
      }
      for (const directory of found) watchDirectory(directory);
    } finally {
      refreshing = false;
    }
  };

  function scheduleRefresh() {
    if (closed) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refresh().catch((error) => onError?.(error));
    }, 250);
  }

  await refresh();

  return {
    fallback: true,
    close() {
      closed = true;
      clearTimeout(refreshTimer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
