import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

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

const IGNORED_DIRS = new Set(['node_modules']);

/**
 * Compress and transcode every image under the given files/directories.
 *
 * @param {string|string[]} inputs
 * @param {object} [options]
 * @returns {Promise<object>} run report
 */
export async function optimize(inputs, options = {}) {
  const startedAt = Date.now();
  const cfg = normalizeOptions(options);
  const { specs, skipped } = await collectSources(inputs, cfg);
  const claimed = new Map();

  const settled = await mapLimit(specs, cfg.concurrency, async (spec) => {
    try {
      const file = await processSource(spec, cfg, claimed);
      if (file.skip) return { skipped: { input: spec.file, reason: file.skip } };
      return { file };
    } catch (error) {
      return { failed: { input: spec.file, error: error.message } };
    }
  });

  const files = settled.filter((r) => r.file).map((r) => r.file);
  for (const r of settled) {
    if (r.skipped) skipped.push(r.skipped);
  }
  const failed = settled.filter((r) => r.failed).map((r) => r.failed);

  files.sort((a, b) => a.input.localeCompare(b.input));
  skipped.sort((a, b) => a.input.localeCompare(b.input));
  failed.sort((a, b) => a.input.localeCompare(b.input));

  const sourceBytes = files.reduce((sum, f) => sum + f.sourceBytes, 0);
  const outputBytes = cfg.dryRun
    ? null
    : files.reduce((sum, f) => sum + f.outputs.reduce((n, o) => n + (o.bytes ?? 0), 0), 0);

  return {
    options: {
      outDir: cfg.outDir,
      formats: cfg.formats,
      widths: cfg.widths,
      quality: cfg.quality,
      recursive: cfg.recursive,
      concurrency: cfg.concurrency,
      flat: cfg.flat,
      dryRun: cfg.dryRun,
      keepMetadata: cfg.keepMetadata,
      background: cfg.background,
    },
    files,
    skipped,
    failed,
    totals: {
      files: files.length,
      outputs: files.reduce((sum, f) => sum + f.outputs.length, 0),
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
 * @returns {Promise<{data: Buffer, info: {format: string, width: number, height: number, bytes: number}}>}
 */
export async function transcode(input, options = {}) {
  const buffer = typeof input === 'string' ? await fs.readFile(input) : Buffer.from(input);
  const format = normalizeFormat(options.format ?? 'webp');
  const quality = resolveSingleQuality(options.quality, format);
  const background = options.background ?? '#ffffff';
  const meta = await sharp(buffer).metadata();
  if ((meta.pages ?? 1) > 1) throw new Error('animated images are not supported yet');

  let pipeline = sharp(buffer).rotate();
  if (options.width) {
    pipeline = pipeline.resize({
      width: toPositiveInt(options.width, 'width'),
      withoutEnlargement: true,
    });
  }
  if (format === 'jpeg') pipeline = pipeline.flatten({ background });
  if (options.keepMetadata) pipeline = pipeline.withMetadata({ orientation: 1 });

  const { data, info } = await pipeline[format](encoderOptions(format, quality))
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    info: {
      format,
      width: info.width,
      height: info.height,
      bytes: info.size,
      sourceWidth: orientedWidth(meta),
    },
  };
}

function normalizeOptions(options) {
  const formats = normalizeFormats(options.formats ?? ['avif', 'webp']);
  const quality = normalizeQuality(options.quality);
  const widths = normalizeWidths(options.widths);
  const outDir = path.resolve(options.outDir ?? 'pixelpress-out');
  const background = options.background ?? '#ffffff';
  if (typeof background !== 'string' || background.trim() === '') {
    throw new TypeError('background must be a non-empty color string');
  }
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$|^[a-z]+$/i.test(background)) {
    throw new TypeError(`background must be a hex or CSS color name, got "${background}"`);
  }

  return {
    outDir,
    formats,
    quality,
    widths,
    background,
    recursive: Boolean(options.recursive),
    flat: Boolean(options.flat),
    dryRun: Boolean(options.dryRun),
    keepMetadata: Boolean(options.keepMetadata),
    concurrency: options.concurrency == null
      ? 4
      : toPositiveInt(options.concurrency, 'concurrency'),
  };
}

function normalizeFormats(input) {
  const list = typeof input === 'string' ? input.split(',') : input;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError(`formats must be a non-empty array or comma-separated string`);
  }
  return [...new Set(list.map((format) => normalizeFormat(String(format).trim())))];
}

function normalizeFormat(value) {
  const format = value.toLowerCase();
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

function resolveSingleQuality(input, format) {
  if (input == null) return DEFAULT_QUALITY[format];
  if (typeof input === 'number') {
    assertQuality(input, 'quality');
    return input;
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('quality must be a number or an object like { avif: 50, webp: 75 }');
  }
  const value = input[format] ?? input.jpg ?? DEFAULT_QUALITY[format];
  assertQuality(value, `quality.${format}`);
  return value;
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

function toPositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return number;
}

function encoderOptions(format, quality) {
  switch (format) {
    case 'avif':
      return { avif: { quality, effort: 4 } };
    case 'webp':
      return { webp: { quality, effort: 4 } };
    case 'jpeg':
      return { jpeg: { quality, mozjpeg: true, progressive: true } };
    case 'png':
      return quality >= 100
        ? { png: { compressionLevel: 9, effort: 10 } }
        : { png: { compressionLevel: 9, effort: 10, palette: true, quality } };
    default:
      throw new TypeError(`unsupported format "${format}"`);
  }
}

async function collectSources(inputs, cfg) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).filter(Boolean);
  if (list.length === 0) throw new TypeError('provide at least one input file or directory');

  const specs = new Map();
  const skipped = [];

  for (const input of list) {
    const absolute = path.resolve(String(input));
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch (error) {
      throw new Error(`cannot read input "${input}": ${error.code === 'ENOENT' ? 'not found' : error.message}`);
    }

    if (stat.isDirectory()) {
      if (absolute === cfg.outDir) {
        throw new Error(`output directory must differ from input directory: ${absolute}`);
      }
      const files = [];
      await walk(absolute, files, cfg, cfg.outDir);
      const prefix = list.length > 1 ? path.basename(absolute) : '';
      for (const file of files) {
        const relative = cfg.flat
          ? path.basename(file)
          : path.join(prefix, path.relative(absolute, file));
        if (!specs.has(file)) specs.set(file, { file, relative });
      }
    } else if (stat.isFile()) {
      if (!INPUT_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
        skipped.push({ input: absolute, reason: 'unsupported file type' });
        continue;
      }
      const relative = path.basename(absolute);
      if (!specs.has(absolute)) specs.set(absolute, { file: absolute, relative });
    } else {
      throw new Error(`unsupported input: ${absolute}`);
    }
  }

  return {
    specs: [...specs.values()],
    skipped,
  };
}

async function walk(dir, files, cfg, outDir) {
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
      if (full === outDir || isInside(outDir, full)) continue;
      if (cfg.recursive) await walk(full, files, cfg, outDir);
    } else if (entry.isFile() && INPUT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function processSource(spec, cfg, claimed) {
  let meta;
  try {
    meta = await sharp(spec.file).metadata();
  } catch (error) {
    throw new Error(`cannot read image: ${error.message}`);
  }

  if ((meta.pages ?? 1) > 1) {
    return { skip: 'animated images are not supported yet' };
  }

  const sourceWidth = orientedWidth(meta);
  const widths = targetWidths(sourceWidth, cfg.widths);
  const outputs = [];

  for (const width of widths) {
    for (const format of cfg.formats) {
      const outPath = outputPath(spec, cfg, format, width);
      if (outPath === spec.file) {
        throw new Error('output would overwrite the input file; choose a different --out');
      }
      claim(claimed, outPath, spec.file);

      if (cfg.dryRun) {
        outputs.push({ format, path: outPath, width: width ?? null, height: null, bytes: null });
        continue;
      }

      await fs.mkdir(path.dirname(outPath), { recursive: true });
      let pipeline = sharp(spec.file).rotate();
      if (width && width !== sourceWidth) {
        pipeline = pipeline.resize({ width, withoutEnlargement: true });
      }
      if (format === 'jpeg') pipeline = pipeline.flatten({ background: cfg.background });
      if (cfg.keepMetadata) pipeline = pipeline.withMetadata({ orientation: 1 });

      const info = await pipeline[format](encoderOptions(format, cfg.quality[format])).toFile(outPath);
      outputs.push({ format, path: outPath, width: info.width, height: info.height, bytes: info.size });
    }
  }

  return {
    input: spec.file,
    width: sourceWidth,
    height: orientedHeight(meta),
    sourceBytes: meta.size ?? (await fs.stat(spec.file)).size,
    outputs,
  };
}

function orientedWidth(meta) {
  if (!meta.width) return null;
  const rotated = [5, 6, 7, 8].includes(meta.orientation);
  return rotated ? (meta.height ?? meta.width) : meta.width;
}

function orientedHeight(meta) {
  if (!meta.height) return null;
  const rotated = [5, 6, 7, 8].includes(meta.orientation);
  return rotated ? (meta.width ?? meta.height) : meta.height;
}

function targetWidths(sourceWidth, requested) {
  if (requested.length === 0) return [sourceWidth ?? null];
  if (!sourceWidth) return [null];
  const usable = requested.filter((width) => width <= sourceWidth);
  return usable.length > 0 ? usable : [sourceWidth];
}

function outputPath(spec, cfg, format, width) {
  const base = spec.relative.slice(0, spec.relative.length - path.extname(spec.relative).length);
  const extension = format === 'jpeg' ? 'jpg' : format;
  const suffix = cfg.widths.length > 0 && width ? `-${width}` : '';
  return path.join(cfg.outDir, `${base}${suffix}.${extension}`);
}

function claim(claimed, outPath, input) {
  const owner = claimed.get(outPath);
  if (owner && owner !== input) {
    throw new Error(`output collision at ${outPath}; two inputs map to one path`);
  }
  claimed.set(outPath, input);
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
