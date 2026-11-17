#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { watch as fsWatch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from './atomic.js';
import { optimize, transcode } from './index.js';
import { createWatcher } from './watch.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const DEFAULT_CONFIG = 'pixelpress.config.json';
const WATCH_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff', '.svg',
]);

const HELP = `pixelpress ${pkg.version} — press images into next-gen formats

Usage
  pixelpress <file|dir|glob...> [options]
  pixelpress --config pixelpress.config.json

Input
  -r, --recursive              include subdirectories
      --include <glob>         only process matching files (repeatable)
      --exclude <glob>         skip matching files (repeatable)
      --follow-symlinks        follow symlinked files and directories
      --config <file>          JSON or ESM config (auto: pixelpress.config.json)

Output
  -o, --out <dir>              output directory              (default: pixelpress-out)
  -f, --formats <list>         avif,webp,jpeg,png            (default: avif,webp)
      --preset <name>          web, thumb, social, lossless
  -w, --widths <list>          responsive widths, e.g. 480,960,1920
      --width <px>             single resize width
      --height <px>            single resize height
      --fit <mode>             cover,contain,fill,inside,outside  (default: inside)
      --position <pos>         crop gravity                  (default: center)
      --enlarge                allow upscaling
      --prefix <text>          prepend to output filenames
      --suffix <text>          append to output filenames
      --hash                   append an 8-char content hash
      --flat                   flatten the output tree
      --clean                  delete the output directory first
      --preserve-dates         keep source timestamps on outputs

Transforms
      --rotate <deg>           rotate (overrides EXIF auto-orientation)
      --no-auto-orient         ignore EXIF orientation
      --flip                   flip vertically
      --flop                   flop horizontally
      --grayscale              convert to grayscale
      --blur <sigma>           Gaussian blur
      --sharpen <sigma>        sharpen (try 1)
      --normalize              stretch contrast
      --gamma <value>          gamma correction
      --tint <color>           tint while keeping luminance
      --trim <threshold>       trim uniform borders
      --extract <WxH+X+Y>      crop a region
      --extend <edges>         pad: n, t,h, or t,r,b,l
      --density <dpi>          rasterize SVG at this density

Encoding
  -q, --quality <value>        1-100, or avif=55,webp=78
      --effort <value>         CPU effort, or avif=6,webp=4,png=10
      --lossless               lossless AVIF/WebP/PNG (not JPEG)
      --progressive            progressive JPEG (default: on)
      --no-progressive         baseline JPEG
      --chroma-subsampling <s> 4:2:0, 4:2:2, or 4:4:4
      --alpha-quality <n>      WebP alpha quality 1-100
      --palette                force PNG palette quantization
      --no-palette             disable PNG palette quantization
      --compression-level <n>  PNG zlib level 0-9         (default: 9)
      --max-bytes <size>       fit each variant, e.g. 150kb
      --background <color>     matte for transparency     (default: #ffffff)
      --keep-metadata          keep EXIF/ICC instead of stripping

Workflow
      --manifest <file>        write a JSON manifest
      --picture <file>         write <picture> snippets
      --report <file>          write a visual HTML report
      --public-path <path>     URL prefix for snippets    (default: /)
      --sizes <value>          sizes attribute for snippets (default: 100vw)
      --lqip                   add a placeholder + dominant color
      --cache                  use the output cache        (default: on)
      --cache-dir <dir>        cache location             (default: node_modules/.cache/pixelpress)
      --no-cache               disable the cache
      --prune                  delete stale outputs no longer produced (requires cache)
      --force                  re-encode even when cached
      --fail-fast              stop after the first failure
      --concurrency <n>        files in parallel           (default: 4)
      --dry-run                plan without writing
      --stdout                 write one encoded image to stdout
      --json                   print the report as JSON
      --quiet                  only print the summary
      --verbose                print every variant
      --watch                  re-run when inputs change
      --init                   create a starter pixelpress.config.json
  -h, --help
  -v, --version

Examples
  pixelpress "assets/**/*.{jpg,png}" -o dist -w 480,960
  pixelpress uploads -o public/img -r --fit cover --width 1600
  pixelpress photos -o dist --max-bytes 120kb --hash --manifest dist/images.json
  pixelpress photos -o dist --picture dist/picture.html --public-path /img
  pixelpress photos -o dist --report dist/report.html
  pixelpress photos -o dist --include "*.jpg" --exclude "draft-*" -r
  pixelpress photos -o dist --watch
  pixelpress --config pixelpress.config.json
  pixelpress photo.jpg -f avif --stdout > photo.avif
  cat photo.jpg | pixelpress - -f webp --stdout > photo.webp
`;

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (supportsColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);
const cyan = paint(36);

main().catch((error) => fail(error.message));

async function main() {
  const { values, positionals } = parseCli(process.argv.slice(2));

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  if (values.init) {
    await initConfig(values.config);
    return;
  }

  const { config, file: configFile } = await resolveConfig(values);
  if (values.watch && values.json) throw new Error('--watch cannot be combined with --json');
  if (values.watch && (values['dry-run'] || config.dryRun)) throw new Error('--watch cannot be combined with --dry-run');
  if (values.watch && (values.clean || config.clean)) throw new Error('--watch cannot be combined with --clean');

  const inputs = positionals.length > 0 ? positionals : toArray(config.inputs);
  if (inputs.length === 0) {
    process.stderr.write(`pixelpress: provide at least one file, directory, or glob\n\n${HELP}`);
    process.exit(1);
  }

  const options = buildOptions(values, config);
  const flags = buildFlags(values, config);
  applyCacheDefaults(values, options);

  const stdoutRequested = Boolean(values.stdout) || values.out === '-' || values['out-dir'] === '-';
  if (flags.watch && stdoutRequested) throw new Error('--watch cannot be combined with --stdout');

  if (flags.watch) {
    await watchMode({ values, positionals, inputs, options, flags, configFile });
    return;
  }

  if (stdoutRequested) {
    await runStdout(inputs, options, flags, values);
    return;
  }

  const result = await runOnce(inputs, options, flags);
  process.exitCode = result.failed.length > 0
    || result.pruneErrors.length > 0
    || (result.files.length === 0 && result.skipped.length > 0)
    ? 1
    : 0;
}

function parseCli(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        'out-dir': { type: 'string' },
        formats: { type: 'string', short: 'f' },
        format: { type: 'string' },
        preset: { type: 'string' },
        quality: { type: 'string', short: 'q' },
        effort: { type: 'string' },
        widths: { type: 'string', short: 'w' },
        width: { type: 'string' },
        height: { type: 'string' },
        fit: { type: 'string' },
        position: { type: 'string' },
        enlarge: { type: 'boolean' },
        prefix: { type: 'string' },
        suffix: { type: 'string' },
        hash: { type: 'boolean' },
        flat: { type: 'boolean' },
        clean: { type: 'boolean' },
        'preserve-dates': { type: 'boolean' },
        recursive: { type: 'boolean', short: 'r' },
        include: { type: 'string', multiple: true },
        exclude: { type: 'string', multiple: true },
        'follow-symlinks': { type: 'boolean' },
        config: { type: 'string', short: 'c' },

        rotate: { type: 'string' },
        'auto-orient': { type: 'boolean' },
        'no-auto-orient': { type: 'boolean' },
        flip: { type: 'boolean' },
        flop: { type: 'boolean' },
        grayscale: { type: 'boolean' },
        blur: { type: 'string' },
        sharpen: { type: 'string' },
        normalize: { type: 'boolean' },
        gamma: { type: 'string' },
        tint: { type: 'string' },
        trim: { type: 'string' },
        extract: { type: 'string' },
        extend: { type: 'string' },
        density: { type: 'string' },

        lossless: { type: 'boolean' },
        progressive: { type: 'boolean' },
        'no-progressive': { type: 'boolean' },
        'chroma-subsampling': { type: 'string' },
        'alpha-quality': { type: 'string' },
        palette: { type: 'boolean' },
        'no-palette': { type: 'boolean' },
        'compression-level': { type: 'string' },
        'max-bytes': { type: 'string' },
        background: { type: 'string' },
        'keep-metadata': { type: 'boolean' },
        metadata: { type: 'boolean' },

        manifest: { type: 'string' },
        picture: { type: 'string' },
        report: { type: 'string' },
        'public-path': { type: 'string' },
        sizes: { type: 'string' },
        lqip: { type: 'boolean' },
        cache: { type: 'boolean' },
        'cache-dir': { type: 'string' },
        'no-cache': { type: 'boolean' },
        prune: { type: 'boolean' },
        force: { type: 'boolean' },
        'fail-fast': { type: 'boolean' },
        concurrency: { type: 'string' },
        'dry-run': { type: 'boolean' },
        stdout: { type: 'boolean' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
        verbose: { type: 'boolean' },
        watch: { type: 'boolean' },
        init: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    fail(error.message);
  }
}

async function initConfig(configPath) {
  const destination = path.resolve(configPath ?? 'pixelpress.config.json');
  try {
    await fs.access(destination);
    throw new Error(`${destination} already exists`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const config = {
    $schema: './node_modules/pixelpress/pixelpress.schema.json',
    preset: 'web',
    inputs: ['src/images/**/*.{jpg,jpeg,png}'],
    outDir: 'public/images',
    recursive: true,
    cache: true,
    prune: true,
  };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await writeFileAtomic(destination, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`pixelpress: created ${show(destination)}\n`);
  process.stdout.write('Edit inputs/outDir, then run: pixelpress\n');
}

async function resolveConfig(values) {
  const candidate = path.resolve(values.config ?? DEFAULT_CONFIG);
  let file = candidate;
  if (!values.config) {
    try {
      await fs.access(candidate);
    } catch {
      // Keep the candidate path so watch mode can detect config creation.
      return { config: {}, file: candidate };
    }
  }

  let data;
  try {
    if (/\.(mjs|cjs|js)$/i.test(file)) {
      const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      data = module.default ?? module;
    } else {
      data = JSON.parse(await fs.readFile(file, 'utf8'));
    }
  } catch (error) {
    throw new Error(`cannot load config ${file}: ${error.message}`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`config ${file} must export an object`);
  }
  const config = { ...data };
  if (config.out != null && config.outDir == null) config.outDir = config.out;
  if (config.format != null && config.formats == null) config.formats = config.format;
  delete config.out;
  delete config.format;
  return { config, file };
}

function buildOptions(values, config) {
  const options = { ...config };
  delete options.inputs;

  const out = values.out ?? values['out-dir'];
  if (out != null) options.outDir = out;
  if (values.formats != null && values.format != null) {
    throw new Error('use --formats or --format, not both');
  }
  if (values.formats != null) options.formats = values.formats;
  if (values.format != null) options.formats = values.format;
  if (values.preset != null) options.preset = values.preset;
  if (values.quality != null) options.quality = parseQuality(values.quality);
  if (values.effort != null) options.effort = parseEffort(values.effort);
  if (values.widths != null) {
    options.widths = values.widths;
    delete options.width;
    delete options.height;
  }
  if (values.width != null || values.height != null) {
    delete options.widths;
    if (values.width != null) options.width = Number(values.width);
    if (values.height != null) options.height = Number(values.height);
  }
  if (values.fit != null) options.fit = values.fit;
  if (values.position != null) options.position = values.position;
  if (values.enlarge != null) options.enlarge = true;
  if (values.prefix != null) options.prefix = values.prefix;
  if (values.suffix != null) options.suffix = values.suffix;
  if (values.hash != null) options.hash = true;
  if (values.flat != null) options.flat = true;
  if (values.clean != null) options.clean = true;
  if (values['preserve-dates'] != null) options.preserveDates = true;
  if (values.recursive != null) options.recursive = true;
  if (values.include != null) options.include = values.include;
  if (values.exclude != null) options.exclude = values.exclude;
  if (values['follow-symlinks'] != null) options.followSymlinks = true;

  if (values.rotate != null) options.rotate = Number(values.rotate);
  if (values['no-auto-orient']) options.autoOrient = false;
  if (values['auto-orient'] != null) options.autoOrient = true;
  if (values.flip != null) options.flip = true;
  if (values.flop != null) options.flop = true;
  if (values.grayscale != null) options.grayscale = true;
  if (values.blur != null) options.blur = Number(values.blur);
  if (values.sharpen != null) options.sharpen = Number(values.sharpen);
  if (values.normalize != null) options.normalize = true;
  if (values.gamma != null) options.gamma = Number(values.gamma);
  if (values.tint != null) options.tint = values.tint;
  if (values.trim != null) options.trim = Number(values.trim);
  if (values.extract != null) options.extract = values.extract;
  if (values.extend != null) options.extend = values.extend;
  if (values.density != null) options.density = Number(values.density);

  if (values.lossless != null) options.lossless = true;
  if (values['no-progressive']) options.progressive = false;
  if (values.progressive != null) options.progressive = true;
  if (values['chroma-subsampling'] != null) options.chromaSubsampling = values['chroma-subsampling'];
  if (values['alpha-quality'] != null) options.alphaQuality = Number(values['alpha-quality']);
  if (values['no-palette']) options.palette = false;
  if (values.palette != null) options.palette = true;
  if (values['compression-level'] != null) options.compressionLevel = Number(values['compression-level']);
  if (values['max-bytes'] != null) options.maxBytes = parseBytes(values['max-bytes']);
  if (values.background != null) options.background = values.background;
  if (values['keep-metadata'] || values.metadata) options.keepMetadata = true;

  if (values.lqip != null) options.lqip = true;
  if (values['cache-dir'] != null) options.cacheDir = values['cache-dir'];
  if (values.prune != null) options.prune = true;
  if (values.force != null) options.force = true;
  if (values['fail-fast'] != null) options.failFast = true;
  if (values['dry-run'] != null) options.dryRun = true;
  if (values.concurrency != null) options.concurrency = Number(values.concurrency);

  return options;
}

function buildFlags(values, config) {
  return {
    json: Boolean(values.json),
    quiet: Boolean(values.quiet),
    verbose: Boolean(values.verbose),
    manifest: values.manifest ?? config.manifest,
    picture: values.picture ?? config.picture,
    report: values.report ?? config.report,
    publicPath: values['public-path'] ?? config.publicPath ?? '/',
    sizes: values.sizes ?? config.sizes ?? '100vw',
    watch: Boolean(values.watch),
  };
}

function applyCacheDefaults(values, options) {
  if (values['no-cache'] === true) options.cache = false;
  if (values.cache === true) options.cache = true;
  if (options.cache === undefined) options.cache = true;
}

async function loadRuntime(values, positionals) {
  const { config, file: configFile } = await resolveConfig(values);
  const inputs = positionals.length > 0 ? positionals : toArray(config.inputs);
  if (inputs.length === 0) throw new Error('no inputs found in config');
  const options = buildOptions(values, config);
  applyCacheDefaults(values, options);
  return { config, configFile, inputs, options, flags: buildFlags(values, config) };
}

async function runOnce(inputs, options, flags) {
  const result = await optimize(inputs, options);
  if (flags.manifest) {
    if (result.options.dryRun) {
      if (!flags.json) log(flags, dim('  dry run: manifest not written'));
    } else {
      const manifestPath = path.resolve(flags.manifest);
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      await writeFileAtomic(manifestPath, `${JSON.stringify(publicReport(result), null, 2)}\n`);
    }
  }

  if (flags.picture) {
    if (result.options.dryRun) {
      if (!flags.json) log(flags, dim('  dry run: picture snippets not written'));
    } else {
      const picturePath = path.resolve(flags.picture);
      const snippets = result.files
        .map((file) => buildPicture(file, result.options, flags))
        .filter(Boolean);
      await fs.mkdir(path.dirname(picturePath), { recursive: true });
      await writeFileAtomic(picturePath, `<!-- Generated by pixelpress -->\n\n${snippets.join('\n\n')}\n`);
    }
  }

  if (flags.report) {
    if (result.options.dryRun) {
      if (!flags.json) log(flags, dim('  dry run: report not written'));
    } else {
      const reportPath = path.resolve(flags.report);
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await writeFileAtomic(reportPath, buildReport(result, reportPath));
    }
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(publicReport(result), null, 2)}\n`);
  } else {
    printResult(result, flags);
  }

  return result;
}

async function runStdout(inputs, options, flags, values) {
  if (flags.json) throw new Error('--stdout cannot be combined with --json');
  if (flags.manifest || flags.picture || flags.report) {
    throw new Error('--stdout cannot be combined with --manifest, --picture, or --report');
  }
  if (options.dryRun) throw new Error('--stdout cannot be combined with --dry-run');
  if (options.clean) throw new Error('--stdout cannot be combined with --clean');
  if (inputs.length !== 1) throw new Error('--stdout requires exactly one input');

  const outValue = values.out ?? values['out-dir'];
  if (outValue && outValue !== '-') throw new Error('--stdout cannot be combined with --out');

  const widths = options.widths;
  if (widths != null && widths !== '' && (!Array.isArray(widths) || widths.length > 0)) {
    throw new Error('--stdout requires a single variant; use --width/--height, not --widths');
  }

  const explicitFormats = values.formats ?? values.format ?? options.formats;
  const formats = explicitFormats == null
    ? ['webp']
    : (Array.isArray(explicitFormats) ? explicitFormats : String(explicitFormats).split(','))
      .map((format) => String(format).trim())
      .filter(Boolean);
  if (formats.length !== 1) {
    throw new Error('--stdout requires exactly one format, e.g. -f webp');
  }

  const input = String(inputs[0]);
  let source;
  if (input === '-') {
    source = await readStdin();
  } else {
    if (/[*?[\]{}]/.test(input)) throw new Error('--stdout does not support glob inputs');
    const absolute = path.resolve(input);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch (error) {
      throw new Error(`cannot read input "${input}": ${error.code === 'ENOENT' ? 'not found' : error.message}`);
    }
    if (!stat.isFile()) throw new Error('--stdout requires a single image file or -');
    source = absolute;
  }

  const { data, info } = await transcode(source, { ...options, format: formats[0] });
  await writeStdout(data);

  if (!values.quiet) {
    const frames = info.animated ? ` · ${info.pages} frames` : '';
    process.stderr.write(`pixelpress: ${info.format} ${info.width}×${info.height} · ${bytes(info.bytes)}${frames}\n`);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

function writeStdout(buffer) {
  return new Promise((resolve, reject) => {
    process.stdout.write(buffer, (error) => (error ? reject(error) : resolve()));
  });
}

function printResult(result, flags) {  const { totals } = result;
  if (!flags.quiet) {
    log(flags, [
      bold('pixelpress'),
      result.options.dryRun ? dim('(dry run)') : '',
      `${count(result.files.length, 'file')} → ${result.options.outDir}`,
      dim(`(${result.options.formats.join(',')})`),
    ].filter(Boolean).join(' '));

    for (const file of result.files) {
      const outBytes = file.outputs.reduce((sum, output) => sum + (output.bytes ?? 0), 0);
      if (result.options.dryRun) {
        const formats = [...new Set(file.outputs.map((output) => output.format))].join(',');
        log(flags, `  ${dim('·')} ${show(file.input)} → ${formats}  ${dim(`(${file.outputs.length})`)}`);
      } else {
        const percent = file.sourceBytes > 0 ? Math.round((1 - outBytes / file.sourceBytes) * 100) : 0;
        const change = file.cached
          ? cyan('cached')
          : percent >= 0
            ? green(`${percent}% smaller`)
            : yellow(`${Math.abs(percent)}% larger`);
        log(flags, `  ${green('✓')} ${show(file.input)}  ${dim(`${bytes(file.sourceBytes)} → ${bytes(outBytes)}`)}  ${change}`);
      }

      if (flags.verbose) {
        for (const output of file.outputs) {
          const size = output.bytes == null ? '?' : bytes(output.bytes);
          const frames = output.animated ? ` ${output.pages}f` : '';
          log(flags, `      ${output.format.padEnd(4)} ${String(output.width ?? '?').padStart(5)}w ${String(output.height ?? '?').padStart(5)}h ${dim(`${size}${frames} q=${output.quality ?? '?'}`)} ${show(output.path)}`);
        }
      }
    }

    for (const item of result.skipped) {
      log(flags, `  ${dim('·')} ${show(item.input)}  ${dim(item.reason)}`);
    }

    if (flags.verbose) {
      for (const item of result.pruned) {
        log(flags, `  ${dim('−')} ${show(item)}  ${dim('pruned')}`);
      }
    }
  }

  for (const item of result.failed) {
    process.stderr.write(`  ${red('✗')} ${show(item.input)}  ${item.error}\n`);
  }
  for (const item of result.pruneErrors) {
    process.stderr.write(`  ${red('✗')} cannot prune ${show(item.path)}  ${item.error}\n`);
  }

  if (flags.manifest && !flags.quiet && !result.options.dryRun) {
    log(flags, `  ${dim('manifest')} → ${show(path.resolve(flags.manifest))}`);
  }
  if (flags.picture && !flags.quiet && !result.options.dryRun) {
    log(flags, `  ${dim('picture')} → ${show(path.resolve(flags.picture))}`);
  }
  if (flags.report && !flags.quiet && !result.options.dryRun) {
    log(flags, `  ${dim('report')} → ${show(path.resolve(flags.report))}`);
  }

  if (result.options.dryRun) {
    log(flags, `\n${bold(count(totals.files, 'file'))} · ${count(totals.outputs, 'output')} planned · nothing written`);
  } else {
    const cached = totals.cached > 0 ? ` (${totals.cached} cached)` : '';
    const pruned = totals.pruned > 0 ? ` · ${totals.pruned} pruned` : '';
    const sizes = totals.sourceBytes > 0
      ? `${bytes(totals.sourceBytes)} → ${bytes(totals.outputBytes)}  ${
        totals.savedPercent >= 0
          ? green(`(${totals.savedPercent}% smaller)`)
          : yellow(`(${Math.abs(totals.savedPercent)}% larger)`)
      }`
      : `${bytes(totals.outputBytes ?? 0)} written`;
    log(flags, `\n${bold(count(totals.files, 'file'))} · ${count(totals.outputs, 'output')}${cached}${pruned} · ${sizes} · ${(totals.durationMs / 1000).toFixed(1)}s`);
  }
  if (totals.skipped > 0) log(flags, dim(`${count(totals.skipped, 'file')} skipped`));
  if (totals.failed > 0) log(flags, red(`${count(totals.failed, 'file')} failed`));
  if (totals.pruneErrors > 0) log(flags, red(`${count(totals.pruneErrors, 'prune error')}`));
}

async function watchMode({ values, positionals, inputs, options, flags, configFile }) {
  let active = { inputs, options, flags };
  let running = false;
  let pending = false;
  let timer = null;
  let configTimer = null;
  let watcher = null;
  let configWatcher = null;
  let watcherKey = '';

  const schedule = () => {
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (running) return;
      run();
    }, 250);
  };

  const run = async ({ announce = true } = {}) => {
    if (running) return;
    running = true;
    pending = false;
    try {
      if (announce && !active.flags.quiet) {
        log(active.flags, dim(`\n[${new Date().toLocaleTimeString()}] change detected`));
      }
      await runOnce(active.inputs, active.options, active.flags);
    } catch (error) {
      process.stderr.write(`pixelpress: ${error.message}\n`);
    } finally {
      running = false;
      if (pending) schedule();
    }
  };

  const setupWatchers = async () => {
    const roots = await watchRoots(active.inputs);
    const key = `${active.options.outDir}\n${[...roots].sort().join('\n')}`;
    if (watcher && key === watcherKey) return roots;
    watcher?.close();
    watcher = await createWatcher({
      roots,
      outDir: active.options.outDir,
      forceFallback: /^(1|true)$/i.test(process.env.PIXELPRESS_WATCH_FALLBACK ?? ''),
      onChange: (changed) => {
        if (!isIgnoredChange(changed, active.options, active.flags)) schedule();
      },
      onError: (error) => process.stderr.write(`pixelpress: watch error: ${error.message}\n`),
    });
    watcherKey = key;
    return roots;
  };

  await run({ announce: false });
  let roots = await setupWatchers();

  const reload = async () => {
    try {
      const next = await loadRuntime(values, positionals);
      if (next.options.dryRun) throw new Error('--watch cannot be combined with --dry-run');
      if (next.options.clean) throw new Error('--watch cannot be combined with --clean');
      active = { inputs: next.inputs, options: next.options, flags: next.flags };
      roots = await setupWatchers();
      if (!active.flags.quiet) {
        log(active.flags, dim(`config reloaded · watching ${roots.join(', ')}`));
      }
      schedule();
    } catch (error) {
      process.stderr.write(`pixelpress: config reload failed: ${error.message}\n`);
    }
  };

  const onConfigChange = () => {
    clearTimeout(configTimer);
    configTimer = setTimeout(() => { reload(); }, 300);
  };
  if (configFile) {
    configWatcher = watchConfigFile(
      configFile,
      onConfigChange,
      (error) => process.stderr.write(`pixelpress: config watch error: ${error.message}\n`),
    );
  }

  if (!active.flags.quiet) {
    log(active.flags, dim(`\nwatching ${roots.join(', ')}${watcher.fallback ? ' · fallback watchers' : ''} · Ctrl+C to stop`));
  }

  const close = () => {
    watcher?.close();
    configWatcher?.close();
    clearTimeout(timer);
    clearTimeout(configTimer);
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function watchConfigFile(file, onChange, onError) {
  const directory = path.dirname(file);
  const name = path.basename(file);
  try {
    const watcher = fsWatch(directory, { persistent: true }, (_event, filename) => {
      if (!filename || String(filename) === name) onChange();
    });
    watcher.on('error', onError);
    return watcher;
  } catch (error) {
    onError(error);
    return null;
  }
}

function isIgnoredChange(changed, options, flags) {
  if (changed === options.outDir || isInside(options.outDir, changed)) return true;
  const absolute = path.resolve(changed);
  const marker = `${path.sep}node_modules${path.sep}`;
  const git = `${path.sep}.git${path.sep}`;
  if (absolute.includes(marker) || absolute.includes(git)) return true;
  for (const file of [flags.manifest, flags.picture, flags.report]) {
    if (file && absolute === path.resolve(file)) return true;
  }
  const extension = path.extname(absolute).toLowerCase();
  if (extension && !WATCH_EXTENSIONS.has(extension)) return true;
  return false;
}

async function watchRoots(inputs) {
  const roots = new Set();
  for (const input of inputs) {
    const raw = String(input);
    if (/[*?[\]{}]/.test(raw)) {
      roots.add(staticRoot(raw));
      continue;
    }
    const absolute = path.resolve(raw);
    try {
      const stat = await fs.stat(absolute);
      roots.add(stat.isDirectory() ? absolute : path.dirname(absolute));
    } catch {
      roots.add(path.dirname(absolute));
    }
  }
  return [...roots];
}

function staticRoot(pattern) {
  const normalized = pattern.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const index = segments.findIndex((segment) => /[*?[\]{}]/.test(segment));
  if (index === -1) return path.dirname(path.resolve(pattern));
  return path.resolve(segments.slice(0, index).join('/') || '.');
}

function publicReport(result) {
  return {
    version: 4,
    generatedAt: new Date().toISOString(),
    options: result.options,
    files: result.files.map((file) => ({
      input: rel(file.input),
      width: file.width,
      height: file.height,
      sourceBytes: file.sourceBytes,
      cached: file.cached,
      ...(file.placeholder ? { placeholder: file.placeholder } : {}),
      ...(file.dominantColor ? { dominantColor: file.dominantColor } : {}),
      outputs: file.outputs.map((output) => ({
        format: output.format,
        path: rel(output.path),
        width: output.width,
        height: output.height,
        bytes: output.bytes,
        quality: output.quality,
        animated: output.animated,
        pages: output.pages,
      })),
      srcset: buildSrcset(file, result.options),
    })),
    skipped: result.skipped.map((item) => ({ input: rel(item.input), reason: item.reason })),
    failed: result.failed.map((item) => ({ input: rel(item.input), error: item.error })),
    pruned: result.pruned.map((item) => rel(item)),
    pruneErrors: result.pruneErrors.map((item) => ({ path: rel(item.path), error: item.error })),
    totals: result.totals,
  };
}

function buildSrcset(file, options) {
  const srcset = {};
  for (const format of ['avif', 'webp', 'jpeg', 'png']) {
    const outputs = file.outputs
      .filter((output) => output.format === format)
      .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    if (outputs.length === 0) continue;
    srcset[format] = outputs
      .map((output) => (options.widths.length > 0 && output.width
        ? `${rel(output.path)} ${output.width}w`
        : rel(output.path)))
      .join(', ');
  }
  return srcset;
}

function buildPicture(file, options, flags) {
  const groups = new Map();
  for (const output of file.outputs) {
    if (!groups.has(output.format)) groups.set(output.format, []);
    groups.get(output.format).push(output);
  }
  const fallbackFormat = (file.outputs.some((output) => output.animated)
    ? ['jpeg', 'png', 'avif', 'webp']
    : ['jpeg', 'png', 'webp', 'avif']
  ).find((format) => groups.has(format));
  if (!fallbackFormat) return '';
  const sourceOrder = file.outputs.some((output) => output.animated)
    ? ['webp', 'avif', 'jpeg', 'png']
    : ['avif', 'webp', 'jpeg', 'png'];

  const url = (output) => joinUrl(
    flags.publicPath,
    path.relative(options.outDir, output.path).split(path.sep).join('/'),
  );
  const largest = (list) => list.reduce((best, item) => ((item.width ?? 0) > (best.width ?? 0) ? item : best));
  const srcset = (list) => [...list]
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
    .map((output) => (options.widths.length > 0 && output.width ? `${url(output)} ${output.width}w` : url(output)))
    .join(', ');

  const fallback = largest(groups.get(fallbackFormat));
  const sizes = flags.sizes ? ` sizes="${escapeHtml(flags.sizes)}"` : '';
  const sources = sourceOrder
    .filter((format) => format !== fallbackFormat && groups.has(format))
    .map((format) => `  <source type="image/${format}" srcset="${escapeHtml(srcset(groups.get(format)))}"${sizes}>`);

  const fallbackOutputs = groups.get(fallbackFormat);
  const imgSrcset = fallbackOutputs.length > 1
    ? ` srcset="${escapeHtml(srcset(fallbackOutputs))}"`
    : '';
  const dimensions = fallback.width && fallback.height
    ? ` width="${fallback.width}" height="${fallback.height}"`
    : '';
  const img = `  <img src="${escapeHtml(url(fallback))}"${imgSrcset}${sizes}${dimensions} alt="" loading="lazy" decoding="async">`;

  return `<!-- ${escapeHtml(show(file.input))} -->\n<picture>\n${[...sources, img].join('\n')}\n</picture>`;
}

function buildReport(result, reportPath) {
  const reportDir = path.dirname(reportPath);
  const { totals, options } = result;
  const saved = totals.savedPercent == null
    ? ''
    : totals.savedPercent >= 0
      ? `${totals.savedPercent}% smaller`
      : `${Math.abs(totals.savedPercent)}% larger`;
  const cards = result.files.map((file) => {
    const outputs = file.outputs.filter((output) => output.bytes != null);
    if (outputs.length === 0) return '';
    const totalBytes = outputs.reduce((sum, output) => sum + output.bytes, 0);
    const percent = file.sourceBytes > 0 ? Math.round((1 - totalBytes / file.sourceBytes) * 100) : 0;
    const preview = pickPreview(outputs);
    const sourceUrl = fileUrl(reportDir, file.input);
    const previewUrl = fileUrl(reportDir, preview.path);
    const swatch = file.dominantColor
      ? `<span class="swatch" style="background-color:${escapeHtml(file.dominantColor)}"></span>`
      : '';
    const rows = outputs.map((output) => `
          <tr>
            <td>${escapeHtml(output.format)}</td>
            <td>${output.width ?? '?'} × ${output.height ?? '?'}</td>
            <td>${bytes(output.bytes)}</td>
            <td>${output.quality}${output.animated ? ` · ${output.pages} frames` : ''}</td>
          </tr>`).join('');

    return `
      <article class="card">
        <div class="card-head">
          <div>
            <h2 title="${escapeHtml(file.input)}">${escapeHtml(path.basename(file.input))}</h2>
            <p class="muted">${swatch}${escapeHtml(rel(file.input))} · ${file.width ?? '?'} × ${file.height ?? '?'} source · ${outputs.length} output${outputs.length === 1 ? '' : 's'}${file.cached ? ' · cached' : ''}</p>
          </div>
          <span class="pill ${percent >= 0 ? 'good' : 'bad'}">${percent >= 0 ? `${percent}% smaller` : `${Math.abs(percent)}% larger`}</span>
        </div>
        <div class="shots">
          <figure>
            <img src="${escapeHtml(sourceUrl)}" alt="" loading="lazy">
            <figcaption>source · ${bytes(file.sourceBytes)}</figcaption>
          </figure>
          <figure class="out">
            <img src="${escapeHtml(previewUrl)}" alt="" loading="lazy">
            <figcaption>${escapeHtml(preview.format)} · ${bytes(totalBytes)} total</figcaption>
          </figure>
        </div>
        <table>
          <thead><tr><th>Format</th><th>Size</th><th>Bytes</th><th>Quality</th></tr></thead>
          <tbody>${rows}
          </tbody>
        </table>
      </article>`;
  }).filter(Boolean).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pixelpress report</title>
<style>
  :root { color-scheme: dark; --bg: #0b0d12; --panel: #141923; --panel-2: #0f131b; --text: #e7ecf3; --muted: #8b98ab; --line: #253044; --good: #4ade80; --bad: #f87171; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .hero { max-width: 1500px; margin: 0 auto 24px; }
  h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.02em; }
  h1 span { color: var(--muted); font-weight: 400; }
  .hero p { margin: 4px 0; color: var(--muted); }
  .hero strong { color: var(--text); }
  .grid { max-width: 1500px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(370px, 1fr)); gap: 18px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px; overflow: hidden; }
  .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .card h2 { margin: 0; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
  .muted { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
  .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: 0; }
  .pill { flex: none; border-radius: 999px; padding: 3px 9px; font-size: 11px; font-weight: 700; }
  .pill.good { background: rgba(74, 222, 128, 0.12); color: var(--good); }
  .pill.bad { background: rgba(248, 113, 113, 0.12); color: var(--bad); }
  .shots { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 14px 0; }
  figure { margin: 0; border-radius: 9px; overflow: hidden; background: var(--panel-2); }
  figure img { display: block; width: 100%; height: 150px; object-fit: contain; background-image: linear-gradient(45deg, #1a202c 25%, transparent 25%), linear-gradient(-45deg, #1a202c 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1a202c 75%), linear-gradient(-45deg, transparent 75%, #1a202c 75%); background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; }
  figcaption { padding: 5px 7px; color: var(--muted); font-size: 11px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { text-align: left; padding: 5px 4px; border-top: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; }
  td:nth-child(2), td:nth-child(3), td:nth-child(4) { color: var(--muted); }
  footer { max-width: 1500px; margin: 24px auto 0; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
  <header class="hero">
    <h1>pixelpress <span>report</span></h1>
    <p><strong>${totals.files} files</strong> · ${totals.outputs} outputs · ${bytes(totals.sourceBytes)} → ${bytes(totals.outputBytes ?? 0)}${saved ? ` · <strong>${saved}</strong>` : ''} · ${(totals.durationMs / 1000).toFixed(1)}s</p>
    <p>${escapeHtml(options.formats.join(', '))}${options.widths.length ? ` · widths ${options.widths.join(', ')}` : ''} · ${escapeHtml(options.outDir)}${totals.cached ? ` · ${totals.cached} cached` : ''}</p>
  </header>
  <main class="grid">
${cards}
  </main>
  <footer>Generated by pixelpress ${escapeHtml(pkg.version)} · ${new Date().toISOString()}</footer>
</body>
</html>
`;
}

function pickPreview(outputs) {
  const animated = outputs.find((output) => output.animated);
  if (animated) return animated;
  for (const format of ['webp', 'jpeg', 'png', 'avif']) {
    const candidates = outputs.filter((output) => output.format === format);
    if (candidates.length > 0) {
      return candidates.reduce((best, item) => ((item.width ?? 0) > (best.width ?? 0) ? item : best));
    }
  }
  return outputs[0];
}

function fileUrl(fromDir, target) {
  return path.relative(fromDir, target)
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function joinUrl(base, relative) {
  const trimmed = String(base ?? '/').replace(/\/+$/, '');
  return trimmed ? `${trimmed}/${relative}` : `/${relative}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function parseQuality(value) {
  if (!value.includes('=')) {
    const quality = Number(value);
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
      throw new Error('quality must be an integer between 1 and 100');
    }
    return quality;
  }
  const quality = {};
  for (const pair of value.split(',')) {
    const [format, number] = pair.split('=').map((part) => part.trim());
    if (!format || !number) throw new Error(`invalid quality pair "${pair}"`);
    const parsed = Number(number);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new Error(`quality for ${format} must be between 1 and 100`);
    }
    quality[format] = parsed;
  }
  return quality;
}

function parseEffort(value) {
  if (!value.includes('=')) {
    const effort = Number(value);
    if (!Number.isInteger(effort) || effort < 0) throw new Error('effort must be a non-negative integer');
    return effort;
  }
  const effort = {};
  for (const pair of value.split(',')) {
    const [format, number] = pair.split('=').map((part) => part.trim());
    if (!format || !number) throw new Error(`invalid effort pair "${pair}"`);
    const parsed = Number(number);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`effort for ${format} must be a non-negative integer`);
    effort[format] = parsed;
  }
  return effort;
}

function parseBytes(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(value).trim());
  if (!match) throw new Error(`invalid size "${value}" (try 150kb or 2mb)`);
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  const number = Number(match[1]) * units[(match[2] ?? 'b').toLowerCase()];
  if (!Number.isFinite(number) || number < 1) throw new Error(`invalid size "${value}"`);
  return Math.round(number);
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function rel(file) {
  return path.relative(process.cwd(), file) || file;
}

function show(file) {
  const relative = rel(file);
  return relative.startsWith('..') ? file : relative;
}

function bytes(number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(number ?? 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function count(value, singular) {
  return `${value} ${singular}${value === 1 ? '' : 's'}`;
}

function log(flags, message) {
  if (!flags.json) process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`pixelpress: ${message}\n`);
  process.exit(1);
}
