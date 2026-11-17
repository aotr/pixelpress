import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { writeAtomic } from './atomic.js';
import { loadCache, saveCache } from './cache.js';

export const OUTPUT_FORMATS = ['avif', 'webp', 'jpeg', 'png'];

const INPUT_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff', '.svg',
]);

const DEFAULT_QUALITY = {
  avif: 55,
  webp: 78,
  jpeg: 80,
  png: 80,
};

const DEFAULT_EFFORT = {
  avif: 4,
  webp: 4,
  png: 10,
};

// libvips/this sharp build preserves frames for animated WebP output only.
const ANIMATED_OUTPUT_FORMATS = new Set(['webp']);

const FIT_MODES = ['cover', 'contain', 'fill', 'inside', 'outside'];
const CHROMA_SUBSAMPLING = ['4:2:0', '4:2:2', '4:4:4'];
const IGNORED_DIRS = new Set(['node_modules']);

const PRESETS = {
  web: {
    formats: ['avif', 'webp'],
    widths: [480, 960, 1920],
    quality: { avif: 50, webp: 72 },
    effort: { avif: 5, webp: 4 },
  },
  thumb: {
    formats: ['webp'],
    width: 400,
    quality: { webp: 72 },
    effort: { webp: 4 },
  },
  social: {
    formats: ['jpeg', 'webp'],
    width: 1200,
    height: 630,
    fit: 'cover',
    position: 'center',
    quality: { jpeg: 82, webp: 78 },
  },
  lossless: {
    formats: ['png', 'webp'],
    lossless: true,
    palette: false,
    quality: { png: 100, webp: 100 },
  },
};

/**
 * Compress and transcode every image under the given files, directories, or globs.
 *
 * @param {string|string[]} inputs
 * @param {object} [options]
 * @returns {Promise<object>} run report
 */
export async function optimize(inputs, options = {}) {
  const startedAt = Date.now();
  const cfg = normalizeOptions(options);
  const { specs, skipped } = await collectSources(inputs, cfg);

  if (cfg.clean) {
    assertSafeClean(cfg, inputs);
    if (!cfg.dryRun) await fs.rm(cfg.outDir, { recursive: true, force: true });
  }

  const cache = cfg.cache && !cfg.dryRun
    ? await loadCache(cfg.cacheDir, cfg.outDir, fingerprint(cfg))
    : null;
  const claimed = new Map();
  const processOne = (spec) => processSource(spec, cfg, claimed, cache);

  let settled;
  if (cfg.failFast) {
    settled = [];
    for (const spec of specs) {
      const result = await runSafely(spec, processOne);
      settled.push(result);
      if (result.failed) break;
    }
  } else {
    settled = await mapLimit(specs, cfg.concurrency, (spec) => runSafely(spec, processOne));
  }

  const files = settled.filter((result) => result.file).map((result) => result.file);
  for (const result of settled) {
    if (result.skipped) skipped.push(result.skipped);
  }
  const failed = settled.filter((result) => result.failed).map((result) => result.failed);

  files.sort((a, b) => a.input.localeCompare(b.input));
  skipped.sort((a, b) => a.input.localeCompare(b.input));
  failed.sort((a, b) => a.input.localeCompare(b.input));

  const handled = new Set();
  const skippedInputs = new Set();
  const preserveInputs = new Set();
  for (const result of settled) {
    if (result.file) handled.add(result.file.input);
    if (result.failed) {
      handled.add(result.failed.input);
      preserveInputs.add(result.failed.input);
    }
    if (result.skipped) {
      handled.add(result.skipped.input);
      skippedInputs.add(result.skipped.input);
      preserveInputs.add(result.skipped.input);
    }
  }
  for (const spec of specs) {
    if (!handled.has(spec.file)) preserveInputs.add(spec.file);
  }

  const pruned = cache && cfg.prune && !cfg.dryRun
    ? await pruneOutputs(cache.previousFiles, cfg, files, failed, specs, handled, skippedInputs)
    : { pruned: [], errors: [] };

  const sourceBytes = files.reduce((sum, file) => sum + file.sourceBytes, 0);
  const outputBytes = cfg.dryRun
    ? null
    : files.reduce((sum, file) => sum + file.outputs.reduce((n, output) => n + (output.bytes ?? 0), 0), 0);

  if (cache) {
    const entries = {};
    for (const input of preserveInputs) {
      const previous = cache.previousFiles[input];
      if (previous) entries[input] = { ...previous, stale: true };
    }
    for (const file of files) {
      const meta = file.cacheMeta;
      entries[file.input] = {
        mtimeMs: meta.mtimeMs,
        size: meta.size,
        width: file.width,
        height: file.height,
        sourceBytes: file.sourceBytes,
        outputs: file.outputs,
        placeholder: file.placeholder,
        dominantColor: file.dominantColor,
      };
    }
    // Keep the old cache when a prune deletion failed so the next run can
    // retry instead of forgetting about the stale path.
    if (pruned.errors.length === 0) await saveCache(cache, entries);
  }

  return {
    options: publicOptions(cfg),
    files,
    skipped,
    failed,
    pruned: pruned.pruned,
    pruneErrors: pruned.errors,
    totals: {
      files: files.length,
      outputs: files.reduce((sum, file) => sum + file.outputs.length, 0),
      cached: files.filter((file) => file.cached).length,
      pruned: pruned.pruned.length,
      pruneErrors: pruned.errors.length,
      sourceBytes,
      outputBytes,
      savedBytes: outputBytes === null ? null : sourceBytes - outputBytes,
      savedPercent: outputBytes === null || sourceBytes === 0
        ? null
        : Math.round((1 - outputBytes / sourceBytes) * 100),
      skipped: skipped.length,
      failed: failed.length,
      durationMs: Date.now() - startedAt,
    },
  };
}

/**
 * Transcode a single image (buffer or path) and return the encoded buffer.
 *
 * @param {Buffer|Uint8Array|string} input
 * @param {object} [options]
 * @returns {Promise<{data: Buffer, info: object}>}
 */
export async function transcode(input, options = {}) {
  const buffer = typeof input === 'string' ? await fs.readFile(input) : Buffer.from(input);
  const format = normalizeFormat(options.format ?? 'webp');
  const cfg = normalizeImageOptions(options);
  assertLossless(format, cfg);

  const meta = await sharp(buffer, cfg.density ? { density: cfg.density } : undefined).metadata();
  const animated = (meta.pages ?? 1) > 1 && ANIMATED_OUTPUT_FORMATS.has(format);
  const encoded = await encodeToBuffer(buffer, cfg, format, cfg.width, cfg.height, animated);

  let width = encoded.info.width;
  let height = encoded.info.height;
  let pages = 1;
  if (animated) {
    const outputMeta = await sharp(encoded.data, { animated: true }).metadata();
    width = outputMeta.width ?? width;
    height = outputMeta.pageHeight ?? height;
    pages = outputMeta.pages ?? (meta.pages ?? 1);
  }

  return {
    data: encoded.data,
    info: {
      format,
      width,
      height,
      bytes: encoded.info.size,
      quality: encoded.quality,
      animated,
      pages,
      sourceWidth: orientedWidth(meta),
      sourceHeight: orientedHeight(meta),
    },
  };
}

async function runSafely(spec, processOne) {
  try {
    const file = await processOne(spec);
    if (file.skip) return { skipped: { input: spec.file, reason: file.skip } };
    return { file };
  } catch (error) {
    return { failed: { input: spec.file, error: error.message } };
  }
}

function normalizeOptions(options) {
  const resolved = applyPreset(options);
  const image = normalizeImageOptions(resolved);
  const formats = normalizeFormats(resolved.formats ?? ['avif', 'webp']);
  const widths = normalizeWidths(resolved.widths);

  if (widths.length > 0 && (image.width != null || image.height != null)) {
    throw new TypeError('use either widths (responsive set) or width/height (single resize), not both');
  }
  if (image.lossless && formats.includes('jpeg')) {
    throw new TypeError('lossless is not supported for jpeg');
  }
  if (image.lossless && image.maxBytes != null) {
    throw new TypeError('lossless and maxBytes cannot be combined');
  }

  const prefix = normalizeAffix(resolved.prefix, 'prefix');
  const suffix = normalizeAffix(resolved.suffix, 'suffix');
  const cache = Boolean(resolved.cache);
  const prune = Boolean(resolved.prune);
  if (prune && !cache) throw new TypeError('prune requires cache: true');
  const cacheDir = path.resolve(
    resolved.cacheDir ?? process.env.PIXELPRESS_CACHE_DIR ?? path.join('node_modules', '.cache', 'pixelpress'),
  );

  return {
    ...image,
    preset: resolved.preset ?? null,
    formats,
    widths,
    outDir: path.resolve(resolved.outDir ?? 'pixelpress-out'),
    prefix,
    suffix,
    hash: Boolean(resolved.hash),
    recursive: Boolean(resolved.recursive),
    flat: Boolean(resolved.flat),
    dryRun: Boolean(resolved.dryRun),
    cache,
    cacheDir,
    prune,
    force: Boolean(resolved.force),
    clean: Boolean(resolved.clean),
    failFast: Boolean(resolved.failFast),
    followSymlinks: Boolean(resolved.followSymlinks),
    preserveDates: Boolean(resolved.preserveDates),
    lqip: Boolean(resolved.lqip),
    include: normalizePatterns(resolved.include),
    exclude: normalizePatterns(resolved.exclude),
    concurrency: resolved.concurrency == null ? 4 : toPositiveInt(resolved.concurrency, 'concurrency'),
  };
}

function applyPreset(options) {
  if (options.preset == null) return options;
  const name = String(options.preset).toLowerCase();
  const preset = PRESETS[name];
  if (!preset) {
    throw new TypeError(`unknown preset "${options.preset}" (choose ${Object.keys(PRESETS).join(', ')})`);
  }

  const overrides = {};
  for (const [key, value] of Object.entries(options)) {
    if (key !== 'preset' && value !== undefined) overrides[key] = value;
  }
  const merged = { ...preset, ...overrides };

  if (preset.quality && isPlainObject(overrides.quality)) {
    merged.quality = { ...preset.quality, ...overrides.quality };
  }
  if (preset.effort && isPlainObject(overrides.effort)) {
    merged.effort = { ...preset.effort, ...overrides.effort };
  }
  if (overrides.widths != null) {
    delete merged.width;
    delete merged.height;
  }
  if (overrides.width != null || overrides.height != null) {
    delete merged.widths;
    if (overrides.width != null && overrides.height == null) delete merged.height;
    if (overrides.height != null && overrides.width == null) delete merged.width;
  }

  return { ...merged, preset: name };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeImageOptions(options) {
  const quality = normalizeQuality(options.quality);
  const effort = normalizeEffort(options.effort);
  const background = normalizeColor(options.background ?? '#ffffff', 'background');

  const width = options.width == null ? null : toPositiveInt(options.width, 'width');
  const height = options.height == null ? null : toPositiveInt(options.height, 'height');

  const fit = options.fit == null ? 'inside' : String(options.fit).toLowerCase();
  if (!FIT_MODES.includes(fit)) {
    throw new TypeError(`fit must be one of ${FIT_MODES.join(', ')}`);
  }

  const position = options.position == null ? 'center' : String(options.position);
  if (position.trim() === '') throw new TypeError('position must not be empty');

  const rotate = options.rotate == null ? null : normalizeAngle(options.rotate);
  const blur = options.blur == null ? null : toPositiveNumber(options.blur, 'blur');
  const sharpen = normalizeSharpen(options.sharpen);
  const gamma = options.gamma == null ? null : toPositiveNumber(options.gamma, 'gamma');
  const trim = normalizeTrim(options.trim);
  const tint = options.tint == null ? null : normalizeColor(options.tint, 'tint');
  const extract = normalizeExtract(options.extract);
  const extend = normalizeExtend(options.extend);
  const density = options.density == null ? null : toPositiveInt(options.density, 'density');
  const maxBytes = options.maxBytes == null ? null : toPositiveInt(options.maxBytes, 'maxBytes');

  const progressive = options.progressive !== false;
  const chromaSubsampling = options.chromaSubsampling == null
    ? '4:2:0'
    : String(options.chromaSubsampling);
  if (!CHROMA_SUBSAMPLING.includes(chromaSubsampling)) {
    throw new TypeError(`chromaSubsampling must be one of ${CHROMA_SUBSAMPLING.join(', ')}`);
  }

  const alphaQuality = options.alphaQuality == null
    ? 100
    : toRange(options.alphaQuality, 'alphaQuality', 1, 100);
  const compressionLevel = options.compressionLevel == null
    ? 9
    : toRange(options.compressionLevel, 'compressionLevel', 0, 9);

  let palette = null;
  if (options.palette === true) palette = true;
  if (options.palette === false) palette = false;

  const hooks = normalizeHooks(options.hooks);

  return {
    quality,
    effort,
    width,
    height,
    fit,
    position,
    enlarge: Boolean(options.enlarge),
    autoOrient: options.autoOrient !== false,
    rotate,
    flip: Boolean(options.flip),
    flop: Boolean(options.flop),
    grayscale: Boolean(options.grayscale),
    blur,
    sharpen,
    normalize: Boolean(options.normalize),
    gamma,
    tint,
    trim,
    extract,
    extend,
    density,
    lossless: Boolean(options.lossless),
    progressive,
    chromaSubsampling,
    alphaQuality,
    palette,
    compressionLevel,
    maxBytes,
    background,
    keepMetadata: Boolean(options.keepMetadata),
    hooks,
  };
}

function normalizeHooks(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('hooks must be an object like { beforeEncode, afterEncode }');
  }
  const { beforeEncode = null, afterEncode = null } = input;
  for (const [name, fn] of [['beforeEncode', beforeEncode], ['afterEncode', afterEncode]]) {
    if (fn != null && typeof fn !== 'function') {
      throw new TypeError(`hooks.${name} must be a function`);
    }
  }
  if (beforeEncode == null && afterEncode == null) return null;
  return { beforeEncode, afterEncode };
}

function normalizeFormats(input) {
  const list = typeof input === 'string' ? input.split(',') : input;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError('formats must be a non-empty array or comma-separated string');
  }
  return [...new Set(list.map((format) => normalizeFormat(String(format).trim())))];
}

function normalizeFormat(value) {
  const format = String(value).toLowerCase();
  if (format === 'jpg') return 'jpeg';
  if (!OUTPUT_FORMATS.includes(format)) {
    throw new TypeError(`unsupported format "${value}" (choose ${OUTPUT_FORMATS.join(', ')})`);
  }
  return format;
}

function normalizeQuality(input) {
  if (input == null) return { ...DEFAULT_QUALITY };
  if (typeof input === 'number') {
    assertQuality(input, 'quality');
    return Object.fromEntries(OUTPUT_FORMATS.map((format) => [format, input]));
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('quality must be a number or an object like { avif: 50, webp: 75 }');
  }
  const quality = { ...DEFAULT_QUALITY };
  for (const [key, value] of Object.entries(input)) {
    const format = normalizeFormat(key);
    assertQuality(value, `quality.${key}`);
    quality[format] = value;
  }
  return quality;
}

function normalizeEffort(input) {
  const effort = { ...DEFAULT_EFFORT };
  if (input == null) return effort;
  if (typeof input === 'number') {
    for (const format of Object.keys(effort)) effort[format] = input;
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) {
      const format = normalizeFormat(key);
      if (format === 'jpeg') continue;
      assertEffort(format, value);
      effort[format] = value;
    }
  } else {
    throw new TypeError('effort must be a number or an object like { avif: 6, webp: 4 }');
  }
  for (const [format, value] of Object.entries(effort)) assertEffort(format, value);
  return effort;
}

function assertEffort(format, value) {
  const max = format === 'avif' ? 9 : format === 'webp' ? 6 : 10;
  const min = format === 'png' ? 1 : 0;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`effort for ${format} must be an integer between ${min} and ${max}`);
  }
}

function assertQuality(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new TypeError(`${label} must be an integer between 1 and 100`);
  }
}

function normalizeWidths(input) {
  if (input == null) return [];
  const list = typeof input === 'string' ? input.split(',') : input;
  if (!Array.isArray(list)) throw new TypeError('widths must be an array or comma-separated string');
  const widths = [...new Set(list.map((width) => toPositiveInt(width, 'width')))];
  return widths.sort((a, b) => a - b);
}

function normalizePatterns(input) {
  if (input == null) return [];
  const list = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(list)) throw new TypeError('include/exclude must be a string or array of globs');
  return list.map((pattern) => String(pattern).trim()).filter(Boolean);
}

function normalizeAffix(value, label) {
  if (value == null) return '';
  const text = String(value);
  if (text.includes('/') || text.includes('\\')) {
    throw new TypeError(`${label} must not contain path separators`);
  }
  return text;
}

function normalizeColor(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty color string`);
  }
  const color = value.trim();
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$|^[a-z]+$/i.test(color)) {
    throw new TypeError(`${label} must be a hex or CSS color name, got "${value}"`);
  }
  return color;
}

function normalizeAngle(value) {
  const angle = Number(value);
  if (!Number.isFinite(angle)) throw new TypeError('rotate must be a number of degrees');
  return angle;
}

function normalizeSharpen(value) {
  if (value == null || value === false) return null;
  if (value === true) return 1;
  return toPositiveNumber(value, 'sharpen');
}

function normalizeTrim(value) {
  if (value == null || value === false) return null;
  if (value === true) return 10;
  return toRange(value, 'trim', 1, 100);
}

function toRange(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function toPositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return number;
}

function toPositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
  return number;
}

function normalizeExtract(input) {
  if (input == null) return null;
  if (typeof input === 'string') {
    const match = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/i.exec(input.trim());
    if (!match) throw new TypeError('extract must look like 300x200+10+20');
    const [, width, height, left, top] = match.map(Number);
    return { width, height, left, top };
  }
  if (typeof input === 'object') {
    return {
      width: toPositiveInt(input.width, 'extract.width'),
      height: toPositiveInt(input.height, 'extract.height'),
      left: input.left == null ? 0 : toNonNegativeInt(input.left, 'extract.left'),
      top: input.top == null ? 0 : toNonNegativeInt(input.top, 'extract.top'),
    };
  }
  throw new TypeError('extract must be "WxH+X+Y" or { width, height, left, top }');
}

function normalizeExtend(input) {
  if (input == null) return null;
  let values;
  if (typeof input === 'number' || typeof input === 'string') {
    values = String(input).split(',').map(Number);
  } else if (Array.isArray(input)) {
    values = input.map(Number);
  } else if (typeof input === 'object') {
    const all = input.all == null ? null : toNonNegativeInt(input.all, 'extend.all');
    const pad = (key) => (input[key] == null ? all ?? 0 : toNonNegativeInt(input[key], `extend.${key}`));
    return { top: pad('top'), right: pad('right'), bottom: pad('bottom'), left: pad('left') };
  } else {
    throw new TypeError('extend must be a number, "top,right,bottom,left", or an object');
  }
  if (values.length === 1) values = [values[0], values[0], values[0], values[0]];
  else if (values.length === 2) values = [values[0], values[1], values[0], values[1]];
  if (values.length !== 4 || values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new TypeError('extend must be 1, 2, or 4 non-negative integers');
  }
  const [top, right, bottom, left] = values;
  return { top, right, bottom, left };
}

function toNonNegativeInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return number;
}

function sanitizeOptions(cfg) {
  const copy = { ...cfg };
  delete copy.cache;
  delete copy.cacheDir;
  delete copy.prune;
  delete copy.force;
  delete copy.dryRun;
  delete copy.failFast;
  delete copy.concurrency;
  delete copy.clean;
  return copy;
}

function fingerprint(cfg) {
  // Functions do not survive JSON.stringify, so hook sources are hashed
  // explicitly. Otherwise changing a hook would silently reuse cached output.
  const hooksSource = cfg.hooks
    ? `|${cfg.hooks.beforeEncode?.toString() ?? ''}|${cfg.hooks.afterEncode?.toString() ?? ''}`
    : '';
  return createHash('sha256')
    .update(JSON.stringify(sanitizeOptions(cfg)) + hooksSource)
    .digest('hex')
    .slice(0, 16);
}

function publicOptions(cfg) {
  return { ...cfg };
}

function assertLossless(format, cfg) {
  if (cfg.lossless && format === 'jpeg') throw new TypeError('lossless is not supported for jpeg');
  if (cfg.lossless && cfg.maxBytes != null) throw new TypeError('lossless and maxBytes cannot be combined');
}

async function collectSources(inputs, cfg) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).filter(Boolean);
  if (list.length === 0) throw new TypeError('provide at least one input file, directory, or glob');

  const specs = new Map();
  const skipped = [];

  for (const input of list) {
    const raw = String(input);
    if (isGlob(raw)) {
      const root = globRoot(raw);
      const files = [];
      let matches = 0;
      try {
        for await (const match of fs.glob(raw, { cwd: process.cwd() })) {
          matches += 1;
          const absolute = path.resolve(match);
          let stat;
          try {
            stat = await fs.stat(absolute);
          } catch {
            continue;
          }
          if (stat.isFile() && INPUT_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
            files.push(absolute);
          }
        }
      } catch (error) {
        throw new Error(`cannot expand glob "${raw}": ${error.message}`);
      }
      if (files.length === 0) {
        skipped.push({ input: raw, reason: matches === 0 ? 'no files matched' : 'no supported images matched' });
        continue;
      }
      addSpecs(files, root, list.length > 1 ? path.basename(root) : '', specs, cfg);
      continue;
    }

    const absolute = path.resolve(raw);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch (error) {
      throw new Error(`cannot read input "${raw}": ${error.code === 'ENOENT' ? 'not found' : error.message}`);
    }

    if (stat.isDirectory()) {
      if (absolute === cfg.outDir) {
        throw new Error(`output directory must differ from input directory: ${absolute}`);
      }
      const files = [];
      await walk(absolute, files, cfg, new Set());
      const prefix = list.length > 1 ? path.basename(absolute) : '';
      addSpecs(files, absolute, prefix, specs, cfg);
    } else if (stat.isFile()) {
      const relative = path.basename(absolute);
      if (!INPUT_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
        skipped.push({ input: absolute, reason: 'unsupported file type' });
        continue;
      }
      if (!passesFilters(relative, cfg)) {
        skipped.push({ input: absolute, reason: 'excluded by filter' });
        continue;
      }
      if (!specs.has(absolute)) specs.set(absolute, { file: absolute, relative });
    } else {
      throw new Error(`unsupported input: ${absolute}`);
    }
  }

  return { specs: [...specs.values()], skipped };
}

function addSpecs(files, root, prefix, specs, cfg) {
  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    const local = path.relative(root, file);
    if (!passesFilters(local, cfg)) continue;
    const relative = cfg.flat ? path.basename(file) : path.join(prefix, local);
    if (!specs.has(file)) specs.set(file, { file, relative });
  }
}

function passesFilters(relative, cfg) {
  if (cfg.include.length === 0 && cfg.exclude.length === 0) return true;
  const posix = relative.split(path.sep).join('/');
  const base = path.basename(relative);
  const matches = (pattern) => path.matchesGlob(posix, pattern) || path.matchesGlob(base, pattern);
  if (cfg.include.length > 0 && !cfg.include.some(matches)) return false;
  if (cfg.exclude.some(matches)) return false;
  return true;
}

function isGlob(value) {
  return /[*?[\]{}]/.test(value);
}

function globRoot(pattern) {
  const normalized = pattern.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const index = segments.findIndex((segment) => /[*?[\]{}]/.test(segment));
  if (index === -1) return path.resolve(pattern);
  const staticPart = segments.slice(0, index).join('/');
  return path.resolve(staticPart || '.');
}

async function walk(dir, files, cfg, visited) {
  let real;
  try {
    real = await fs.realpath(dir);
  } catch {
    real = path.resolve(dir);
  }
  if (visited.has(real)) return;
  visited.add(real);

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read directory "${dir}": ${error.message}`);
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (full === cfg.outDir || isInside(cfg.outDir, full)) continue;
      if (cfg.recursive) await walk(full, files, cfg, visited);
    } else if (entry.isFile()) {
      if (INPUT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    } else if (entry.isSymbolicLink() && cfg.followSymlinks) {
      let target;
      try {
        target = await fs.stat(full);
      } catch {
        continue;
      }
      if (target.isDirectory() && cfg.recursive) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (full === cfg.outDir || isInside(cfg.outDir, full)) continue;
        await walk(full, files, cfg, visited);
      } else if (target.isFile() && INPUT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(full);
      }
    }
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertSafeClean(cfg, inputs) {
  const out = cfg.outDir;
  const root = path.parse(out).root;
  const home = path.resolve(os.homedir());
  if (out === root || out === home || out === process.cwd() || isInside(out, process.cwd())) {
    throw new Error(`refusing to clean unsafe output directory: ${out}`);
  }
  const list = (Array.isArray(inputs) ? inputs : [inputs]).filter(Boolean);
  for (const input of list) {
    const absolute = path.resolve(String(input));
    if (absolute === out || isInside(out, absolute)) {
      throw new Error(`refusing to clean ${out}: input ${absolute} lives inside it`);
    }
  }
}

async function pruneOutputs(previousFiles, cfg, files, failed, specs, handled, skippedInputs) {
  const current = new Set();
  for (const file of files) {
    for (const output of file.outputs) current.add(output.path);
  }

  const failedInputs = new Set(failed.map((item) => item.input));
  const specInputs = new Set(specs.map((spec) => spec.file));
  const candidates = new Map();

  for (const [input, entry] of Object.entries(previousFiles)) {
    if (!entry || !Array.isArray(entry.outputs)) continue;
    if (failedInputs.has(input) || skippedInputs.has(input)) continue;
    // A fail-fast run may leave later specs untouched; never prune those.
    if (specInputs.has(input) && !handled.has(input)) continue;

    for (const output of entry.outputs) {
      if (!output || typeof output.path !== 'string' || !path.isAbsolute(output.path)) continue;
      if (current.has(output.path)) continue;
      if (!isInside(cfg.outDir, output.path)) continue;
      if (specInputs.has(output.path)) continue;
      candidates.set(output.path, input);
    }
  }

  const pruned = [];
  const errors = [];
  const directories = new Set();

  for (const candidate of candidates.keys()) {
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      await fs.rm(candidate, { force: true });
      pruned.push(candidate);
      directories.add(path.dirname(candidate));
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push({ path: candidate, error: error.message });
    }
  }

  await removeEmptyDirs(directories, cfg.outDir);
  return { pruned, errors };
}

async function removeEmptyDirs(directories, stopAt) {
  const deepestFirst = [...directories].sort((a, b) => b.length - a.length);
  for (const start of deepestFirst) {
    let directory = start;
    while (isInside(stopAt, directory)) {
      try {
        await fs.rmdir(directory);
      } catch {
        break;
      }
      directory = path.dirname(directory);
    }
  }
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

async function rollbackOutputs(created, outDir) {
  const directories = new Set();
  for (const item of created) {
    if (item.existed) continue;
    try {
      await fs.rm(item.path, { force: true });
      directories.add(path.dirname(item.path));
    } catch {
      // Best effort: the run already failed.
    }
  }
  await removeEmptyDirs(directories, outDir);
}

async function processSource(spec, cfg, claimed, cache) {
  const stat = await fs.stat(spec.file);
  const cached = await fromCache(spec, cfg, cache, claimed, stat);
  if (cached) {
    Object.defineProperty(cached, 'cacheMeta', { value: { mtimeMs: stat.mtimeMs, size: stat.size } });
    return cached;
  }

  let meta;
  try {
    meta = await sharp(spec.file, cfg.density ? { density: cfg.density } : undefined).metadata();
  } catch (error) {
    throw new Error(`cannot read image: ${error.message}`);
  }

  const sourceWidth = orientedWidth(meta);
  const animatedInput = (meta.pages ?? 1) > 1;
  const variants = selectVariants(sourceWidth, cfg);
  const outputs = [];
  const created = [];

  try {
    for (const variant of variants) {
      for (const format of cfg.formats) {
        const keepFrames = animatedInput && ANIMATED_OUTPUT_FORMATS.has(format);
        // afterEncode replaces bytes, so it needs the encoded buffer even when
        // neither hash nor maxBytes would otherwise require one.
        const needsBuffer = cfg.hash || cfg.maxBytes != null || cfg.hooks?.afterEncode != null;
        let encoded = null;

        if (needsBuffer) {
          encoded = await encodeToBuffer(spec.file, cfg, format, variant.width, variant.height, keepFrames);
        }

        const digest = cfg.hash ? sha256(encoded.data) : null;
        const outPath = outputPath(spec, cfg, format, variant.width, digest);
        if (outPath === spec.file) {
          throw new Error('output would overwrite the input file; choose a different --out');
        }
        claim(claimed, outPath, spec.file);

        let info = encoded?.info ?? null;
        const quality = encoded?.quality ?? cfg.quality[format];

        if (!cfg.dryRun) {
          await fs.mkdir(path.dirname(outPath), { recursive: true });
          created.push({ path: outPath, existed: await pathExists(outPath) });
          if (encoded) {
            await writeAtomic(outPath, (temporary) => fs.writeFile(temporary, encoded.data));
          } else {
            info = await writeAtomic(outPath, async (temporary) => {
              const pipeline = await buildPipeline(spec.file, cfg, format, {
                width: variant.width,
                height: variant.height,
                quality,
                animated: keepFrames,
              });
              return pipeline.toFile(temporary);
            });
          }
          if (cfg.preserveDates) {
            await fs.utimes(outPath, stat.atime, stat.mtime);
          }
        }

        let width = info?.width ?? variant.width ?? null;
        let height = info?.height ?? variant.height ?? null;
        let pages = keepFrames ? (meta.pages ?? 1) : 1;
        if (keepFrames && info) {
          const outputMeta = encoded
            ? await sharp(encoded.data, { animated: true }).metadata()
            : await sharp(outPath, { animated: true }).metadata();
          width = outputMeta.width ?? width;
          height = outputMeta.pageHeight ?? height;
          pages = outputMeta.pages ?? (meta.pages ?? 1);
        }

        outputs.push({
          format,
          path: outPath,
          width,
          height,
          bytes: info?.size ?? null,
          quality,
          animated: keepFrames,
          pages,
        });
      }
    }
  } catch (error) {
    await rollbackOutputs(created, cfg.outDir);
    throw error;
  }

  const file = {
    input: spec.file,
    width: sourceWidth,
    height: orientedHeight(meta),
    sourceBytes: stat.size,
    cached: false,
    outputs,
  };

  if (cfg.lqip && !cfg.dryRun) {
    const placeholder = await makePlaceholder(spec.file, cfg);
    if (placeholder) {
      file.placeholder = placeholder.placeholder;
      file.dominantColor = placeholder.dominantColor;
    }
  }

  Object.defineProperty(file, 'cacheMeta', { value: { mtimeMs: stat.mtimeMs, size: stat.size } });
  return file;
}

async function fromCache(spec, cfg, cache, claimed, stat) {
  if (!cache || cfg.force) return null;
  const entry = cache.files[spec.file];
  if (!entry) return null;
  if (entry.stale) return null;
  if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) return null;
  if (!Array.isArray(entry.outputs) || entry.outputs.length === 0) return null;

  for (const output of entry.outputs) {
    if (!output.path || !isInside(cfg.outDir, output.path)) return null;
    try {
      const outputStat = await fs.stat(output.path);
      if (output.bytes != null && outputStat.size !== output.bytes) return null;
    } catch {
      return null;
    }
  }
  for (const output of entry.outputs) claim(claimed, output.path, spec.file);

  const file = {
    input: spec.file,
    width: entry.width ?? null,
    height: entry.height ?? null,
    sourceBytes: entry.sourceBytes ?? stat.size,
    cached: true,
    outputs: entry.outputs,
  };
  if (entry.placeholder) {
    file.placeholder = entry.placeholder;
    file.dominantColor = entry.dominantColor;
  }
  return file;
}

function selectVariants(sourceWidth, cfg) {
  if (cfg.widths.length === 0) {
    return [{ width: cfg.width, height: cfg.height }];
  }
  if (!sourceWidth) {
    return cfg.widths.map((width) => ({ width, height: null }));
  }
  const usable = cfg.enlarge
    ? cfg.widths
    : cfg.widths.filter((width) => width <= sourceWidth);
  const widths = usable.length > 0 ? usable : [sourceWidth];
  return widths.map((width) => ({ width, height: null }));
}

function orientedWidth(meta) {
  if (!meta.width) return null;
  const rotated = [5, 6, 7, 8].includes(meta.orientation);
  return rotated ? (meta.pageHeight ?? meta.height ?? meta.width) : meta.width;
}

function orientedHeight(meta) {
  const pageHeight = meta.pageHeight ?? meta.height;
  if (!pageHeight) return null;
  const rotated = [5, 6, 7, 8].includes(meta.orientation);
  return rotated ? (meta.width ?? pageHeight) : pageHeight;
}

function outputPath(spec, cfg, format, width, digest) {
  const extension = path.extname(spec.relative);
  const directory = path.dirname(spec.relative);
  const name = path.basename(spec.relative, extension);
  const outExtension = format === 'jpeg' ? 'jpg' : format;
  const widthSuffix = cfg.widths.length > 0 && width ? `-${width}` : '';
  const hashSuffix = digest ? `-${digest}` : '';
  const fileName = `${cfg.prefix}${name}${cfg.suffix}${widthSuffix}${hashSuffix}.${outExtension}`;
  return path.join(cfg.outDir, directory === '.' ? '' : directory, fileName);
}

function claim(claimed, outPath, input) {
  const owner = claimed.get(outPath);
  if (owner && owner !== input) {
    throw new Error(`output collision at ${outPath}; two inputs map to one path`);
  }
  claimed.set(outPath, input);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex').slice(0, 8);
}

async function encodeToBuffer(input, cfg, format, width, height, animated = false) {
  const quality = cfg.quality[format];
  const context = { input, format, width, height, quality, animated };
  if (cfg.maxBytes != null) {
    const attempt = (value) => buildPipeline(input, cfg, format, { width, height, quality: value, animated })
      .then((pipeline) => pipeline.toBuffer({ resolveWithObject: true }))
      .then(({ data, info }) => ({ data, info, quality: value }));

    let best = await attempt(quality);
    if (best.info.size <= cfg.maxBytes) return best;

    let low = 1;
    let high = quality - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = await attempt(mid);
      if (candidate.info.size <= cfg.maxBytes) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best.info.size > cfg.maxBytes) {
      const smallest = quality === 1 ? best : await attempt(1);
      if (smallest.info.size > cfg.maxBytes) {
        throw new Error(`cannot fit ${format}${width ? ` at ${width}px` : ''} under maxBytes=${cfg.maxBytes} (smallest output is ${smallest.info.size} bytes)`);
      }
      best = smallest;
    }
    return applyAfterEncode(best, cfg, context);
  }

  const { data, info } = await (await buildPipeline(input, cfg, format, { width, height, quality, animated }))
    .toBuffer({ resolveWithObject: true });
  return applyAfterEncode({ data, info, quality }, cfg, context);
}

async function applyAfterEncode(result, cfg, context) {
  // Runs once on the final bytes, after any maxBytes search, so a hook that
  // replaces data cannot silently break the byte budget it searched for.
  const hook = cfg.hooks?.afterEncode;
  if (!hook) return result;
  const replacement = await hook({ data: result.data, info: result.info }, context);
  if (replacement == null) return result;
  const data = Buffer.isBuffer(replacement) || replacement instanceof Uint8Array
    ? Buffer.from(replacement)
    : replacement.data != null
      ? Buffer.from(replacement.data)
      : null;
  if (!data) return result;
  return { ...result, data, info: { ...result.info, size: data.length } };
}

async function buildPipeline(input, cfg, format, { width, height, quality, animated = false }) {
  let pipeline = sharp(input, {
    ...(cfg.density ? { density: cfg.density } : {}),
    ...(animated ? { animated: true } : {}),
  });

  if (cfg.rotate != null) pipeline = pipeline.rotate(cfg.rotate, { background: cfg.background });
  else if (cfg.autoOrient) pipeline = pipeline.rotate();

  if (cfg.flip) pipeline = pipeline.flip();
  if (cfg.flop) pipeline = pipeline.flop();
  if (cfg.extract) pipeline = pipeline.extract(cfg.extract);
  if (width != null || height != null) {
    pipeline = pipeline.resize({
      width: width ?? undefined,
      height: height ?? undefined,
      fit: cfg.fit,
      position: cfg.position,
      withoutEnlargement: !cfg.enlarge,
      background: cfg.background,
    });
  }
  if (cfg.trim) pipeline = pipeline.trim({ threshold: cfg.trim });
  if (cfg.grayscale) pipeline = pipeline.grayscale();
  if (cfg.blur) pipeline = pipeline.blur(cfg.blur);
  if (cfg.sharpen) pipeline = pipeline.sharpen({ sigma: cfg.sharpen });
  if (cfg.normalize) pipeline = pipeline.normalize();
  if (cfg.gamma != null) pipeline = pipeline.gamma(cfg.gamma);
  if (cfg.tint) pipeline = pipeline.tint(cfg.tint);
  if (cfg.extend) pipeline = pipeline.extend({ ...cfg.extend, background: cfg.background });
  if (format === 'jpeg') pipeline = pipeline.flatten({ background: cfg.background });
  if (cfg.keepMetadata) pipeline = pipeline.withMetadata({ orientation: 1 });

  if (cfg.hooks?.beforeEncode) {
    const replacement = await cfg.hooks.beforeEncode(pipeline, {
      input, format, width, height, quality, animated,
    });
    if (replacement) pipeline = replacement;
  }

  return pipeline[format](encoderOptions(format, cfg, quality));
}

function encoderOptions(format, cfg, quality) {
  switch (format) {
    case 'avif':
      return { quality, effort: cfg.effort.avif, lossless: cfg.lossless };
    case 'webp':
      return {
        quality,
        effort: cfg.effort.webp,
        lossless: cfg.lossless,
        alphaQuality: cfg.alphaQuality,
      };
    case 'jpeg':
      return {
        quality,
        mozjpeg: true,
        progressive: cfg.progressive,
        chromaSubsampling: cfg.chromaSubsampling,
      };
    case 'png': {
      const palette = cfg.lossless
        ? false
        : cfg.palette == null
          ? quality < 100
          : cfg.palette;
      return {
        compressionLevel: cfg.compressionLevel,
        effort: cfg.effort.png,
        ...(palette ? { palette: true, quality } : {}),
      };
    }
    default:
      throw new TypeError(`unsupported format "${format}"`);
  }
}

async function makePlaceholder(input, cfg) {
  try {
    const [preview, color] = await Promise.all([
      sharp(input, cfg.density ? { density: cfg.density } : undefined)
        .rotate()
        .resize({ width: 20, withoutEnlargement: true })
        .webp({ quality: 30 })
        .toBuffer(),
      sharp(input, cfg.density ? { density: cfg.density } : undefined)
        .rotate()
        .resize({ width: 1, height: 1, fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);
    const { data, info } = color;
    const alpha = info.channels === 4 ? data[3] : null;
    const channels = info.channels >= 3 ? [data[0], data[1], data[2]] : [data[0], data[0], data[0]];
    return {
      placeholder: `data:image/webp;base64,${preview.toString('base64')}`,
      dominantColor: alpha === 0 ? '#ffffff' : `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`,
    };
  } catch {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}
