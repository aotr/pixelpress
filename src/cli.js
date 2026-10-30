#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { optimize } from './index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const HELP = `pixelpress ${pkg.version} — press images into next-gen formats

Usage
  pixelpress <file|dir...> [options]

Options
  -o, --out <dir>          output directory              (default: pixelpress-out)
  -f, --formats <list>     avif|webp|jpeg|png            (default: avif,webp)
  -q, --quality <value>    1-100, or avif=55,webp=78      (default: avif 55, webp 78, jpeg 80, png 80)
  -w, --widths <list>      responsive widths, e.g. 480,960,1920
  -r, --recursive          include subdirectories
      --flat               flatten output tree (fails on duplicate names)
      --concurrency <n>    files processed in parallel   (default: 4)
      --background <color> matte for transparent JPEGs   (default: #ffffff)
      --keep-metadata      keep EXIF/ICC instead of stripping it
      --manifest <file>    write a JSON report of every variant
      --dry-run            show the plan without writing files
      --json               print the full report as JSON
  -h, --help               show this help
  -v, --version            show the version

Examples
  pixelpress public/images -o dist/images -r
  pixelpress hero.jpg -f avif,webp -w 480,960,1920 -o dist
  pixelpress assets -o dist --quality avif=50,webp=72 --manifest dist/images.json
  pixelpress . -o dist --json > report.json
`;

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (supportsColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      formats: { type: 'string', short: 'f' },
      quality: { type: 'string', short: 'q' },
      widths: { type: 'string', short: 'w' },
      recursive: { type: 'boolean', short: 'r' },
      flat: { type: 'boolean' },
      concurrency: { type: 'string' },
      background: { type: 'string' },
      'keep-metadata': { type: 'boolean' },
      manifest: { type: 'string' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
} catch (error) {
  fail(error.message);
}

const { values, positionals } = args;

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (positionals.length === 0) {
  process.stderr.write(`pixelpress: provide at least one file or directory\n\n${HELP}`);
  process.exit(1);
}

const json = Boolean(values.json);
const log = (...parts) => {
  if (!json) process.stdout.write(`${parts.join(' ')}\n`);
};

try {
  const options = {
    outDir: values.out ?? 'pixelpress-out',
    formats: values.formats,
    widths: values.widths,
    quality: parseQuality(values.quality),
    recursive: Boolean(values.recursive),
    flat: Boolean(values.flat),
    concurrency: values.concurrency == null ? 4 : parsePositive(values.concurrency, 'concurrency'),
    background: values.background,
    keepMetadata: Boolean(values['keep-metadata']),
    dryRun: Boolean(values['dry-run']),
  };

  const header = [
    bold('pixelpress'),
    `${positionals.join(', ')} → ${path.resolve(options.outDir)}`,
    dim(`(${options.formats ?? 'avif,webp'})`),
  ].join(' ');
  log(header);

  const result = await optimize(positionals, options);
  const report = publicReport(result);

  for (const file of result.files) {
    const outBytes = file.outputs.reduce((sum, output) => sum + (output.bytes ?? 0), 0);
    if (options.dryRun) {
      const formats = [...new Set(file.outputs.map((output) => output.format))].join(', ');
      log(`  ${dim('·')} ${show(file.input)} → ${formats}  ${dim(`(${file.outputs.length})`)}`);
    } else {
      const percent = file.sourceBytes > 0 ? Math.round((1 - outBytes / file.sourceBytes) * 100) : 0;
      const change = percent >= 0 ? green(`${percent}% smaller`) : yellow(`${Math.abs(percent)}% larger`);
      log(`  ${green('✓')} ${show(file.input)}  ${dim(`${bytes(file.sourceBytes)} → ${bytes(outBytes)}`)}  ${change}`);
    }
  }

  for (const item of result.skipped) {
    log(`  ${dim('·')} ${show(item.input)}  ${dim(item.reason)}`);
  }
  for (const item of result.failed) {
    process.stderr.write(`  ${red('✗')} ${show(item.input)}  ${item.error}\n`);
  }

  if (values.manifest) {
    const manifestPath = path.resolve(values.manifest);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, `${JSON.stringify(report, null, 2)}\n`);
    log(`  ${dim('manifest')} → ${show(manifestPath)}`);
  }

  const { totals } = result;
  if (options.dryRun) {
    log(`\n${bold(`${totals.files} files`)} · ${totals.outputs} outputs planned · nothing written`);
  } else {
    const sizes = totals.sourceBytes > 0
      ? `${bytes(totals.sourceBytes)} → ${bytes(totals.outputBytes)}  ${
        totals.savedPercent >= 0
          ? green(`(${totals.savedPercent}% smaller)`)
          : yellow(`(${Math.abs(totals.savedPercent)}% larger)`)
      }`
      : `${bytes(totals.outputBytes)} written`;
    log(`\n${bold(`${totals.files} files`)} · ${totals.outputs} outputs · ${sizes} · ${(totals.durationMs / 1000).toFixed(1)}s`);
    if (totals.skipped > 0) log(dim(`${totals.skipped} skipped`));
    if (totals.failed > 0) log(red(`${totals.failed} failed`));
  }

  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = result.failed.length > 0 || (result.files.length === 0 && result.skipped.length > 0)
    ? 1
    : 0;
} catch (error) {
  fail(error.message);
}

function parseQuality(value) {
  if (value == null) return undefined;
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

function parsePositive(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function publicReport(result) {
  return {
    generatedAt: new Date().toISOString(),
    options: result.options,
    files: result.files.map((file) => ({
      input: rel(file.input),
      width: file.width,
      height: file.height,
      sourceBytes: file.sourceBytes,
      outputs: file.outputs.map((output) => ({
        format: output.format,
        path: rel(output.path),
        width: output.width,
        height: output.height,
        bytes: output.bytes,
      })),
    })),
    skipped: result.skipped.map((item) => ({ input: rel(item.input), reason: item.reason })),
    failed: result.failed.map((item) => ({ input: rel(item.input), error: item.error })),
    totals: result.totals,
  };
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
  let value = number;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function fail(message) {
  process.stderr.write(`pixelpress: ${message}\n`);
  process.exit(1);
}
