import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { optimize, transcode } from '../src/index.js';

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.PIXELPRESS_CACHE_DIR = path.join(os.tmpdir(), 'pixelpress-test-cache');

async function waitFor(predicate, timeout = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('timed out waiting for condition');
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixelpress-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeJpeg(file, width = 800, height = 600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: '#3a6ea5' } })
    .jpeg({ quality: 90 })
    .toFile(file);
}

function noise(width, height) {
  const buffer = Buffer.alloc(width * height * 3);
  for (let index = 0; index < buffer.length; index += 1) {
    buffer[index] = (index * 37 + (index >> 3) * 11) % 256;
  }
  return buffer;
}

async function makeNoise(file, width = 400, height = 300, format = 'jpeg') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const image = sharp(noise(width, height), { raw: { width, height, channels: 3 } });
  if (format === 'png') await image.png().toFile(file);
  else await image.jpeg({ quality: 92 }).toFile(file);
}

test('optimize writes avif and webp variants with a report', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  await makeJpeg(path.join(source, 'photo.jpg'));

  const result = await optimize([source], { outDir: path.join(dir, 'out') });

  assert.equal(result.failed.length, 0);
  assert.equal(result.files.length, 1);
  assert.deepEqual(
    result.files[0].outputs.map((output) => output.format).sort(),
    ['avif', 'webp'],
  );
  for (const output of result.files[0].outputs) {
    assert.ok(output.bytes > 0);
    assert.equal(output.width, 800);
    const meta = await sharp(output.path).metadata();
    assert.equal(meta.format, output.format === 'avif' ? 'heif' : output.format);
  }
  assert.ok(result.totals.outputBytes > 0);
  assert.equal(result.totals.outputs, 2);
});

test('widths resize without upscaling and are reflected in filenames', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  await makeJpeg(path.join(source, 'photo.jpg'), 800, 600);
  const out = path.join(dir, 'out');

  const result = await optimize([source], {
    outDir: out,
    formats: ['webp'],
    widths: [320, 640, 4000],
  });

  assert.equal(result.failed.length, 0);
  assert.deepEqual(
    result.files[0].outputs.map((output) => output.width),
    [320, 640],
  );
  assert.deepEqual(
    result.files[0].outputs.map((output) => path.basename(output.path)),
    ['photo-320.webp', 'photo-640.webp'],
  );
  const meta = await sharp(path.join(out, 'photo-640.webp')).metadata();
  assert.equal(meta.width, 640);
  assert.equal(meta.height, 480);

  const enlarged = await optimize([source], {
    outDir: path.join(dir, 'large'),
    formats: ['webp'],
    widths: [1000],
    enlarge: true,
  });
  assert.equal(enlarged.files[0].outputs[0].width, 1000);
});

test('recursive runs mirror the input directory tree', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  await makeJpeg(path.join(source, 'hero.jpg'), 200, 100);
  await makeJpeg(path.join(source, 'team', 'ana.jpg'), 200, 100);
  const out = path.join(dir, 'out');

  const result = await optimize([source], {
    outDir: out,
    formats: ['webp'],
    recursive: true,
  });

  assert.equal(result.failed.length, 0);
  assert.equal(result.files.length, 2);
  await fs.access(path.join(out, 'hero.webp'));
  await fs.access(path.join(out, 'team', 'ana.webp'));
});

test('exif orientation is applied before resizing', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'rotated.jpg');
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#123456' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(input);

  const result = await optimize([input], {
    outDir: path.join(dir, 'out'),
    formats: ['webp'],
    widths: [100],
  });

  assert.equal(result.failed.length, 0);
  assert.equal(result.files[0].width, 200);
  assert.equal(result.files[0].height, 400);
  const output = result.files[0].outputs[0];
  const meta = await sharp(output.path).metadata();
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 200);
  assert.equal(meta.orientation, undefined);
});

test('transparent png to jpeg is flattened, not broken', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'alpha.png');
  await sharp({
    create: {
      width: 200,
      height: 100,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0.4 },
    },
  }).png().toFile(input);

  const result = await optimize([input], {
    outDir: path.join(dir, 'out'),
    formats: ['jpeg'],
  });

  assert.equal(result.failed.length, 0);
  const output = result.files[0].outputs[0];
  const meta = await sharp(output.path).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.hasAlpha, false);
  assert.equal(meta.width, 200);
});

test('transcode returns an encoded buffer with the requested width', async () => {
  const buffer = await sharp({
    create: { width: 900, height: 600, channels: 3, background: '#222222' },
  }).jpeg().toBuffer();

  const result = await transcode(buffer, { format: 'webp', width: 400, quality: 60 });

  assert.equal(result.info.format, 'webp');
  assert.equal(result.info.width, 400);
  assert.ok(result.data.length > 0);
  const meta = await sharp(result.data).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 400);
});

test('flat output collisions are reported instead of overwritten', async (t) => {
  const dir = await tempDir(t);
  await makeJpeg(path.join(dir, 'a', 'icon.jpg'), 100, 100);
  await makeJpeg(path.join(dir, 'b', 'icon.jpg'), 120, 120);

  const result = await optimize([path.join(dir, 'a'), path.join(dir, 'b')], {
    outDir: path.join(dir, 'out'),
    formats: ['webp'],
    flat: true,
  });

  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /collision/);
  assert.equal(result.totals.files, 1);
});

test('dry run plans variants but writes nothing', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  await makeJpeg(path.join(source, 'photo.jpg'));
  const out = path.join(dir, 'out');

  const result = await optimize([source], { outDir: out, dryRun: true });

  assert.equal(result.failed.length, 0);
  assert.equal(result.totals.outputs, 2);
  assert.equal(result.totals.outputBytes, null);
  assert.equal(result.files[0].outputs[0].bytes, null);
  await assert.rejects(fs.access(out));
});

test('cli writes files, a manifest, and a JSON report', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  await makeJpeg(path.join(source, 'photo.jpg'), 600, 400);
  const out = path.join(dir, 'out');
  const manifest = path.join(dir, 'images.json');

  const { stdout, stderr } = await exec(process.execPath, [
    path.join(root, 'src', 'cli.js'),
    source,
    '--out', out,
    '--formats', 'webp',
    '--widths', '100,200',
    '--manifest', manifest,
    '--json',
  ]);

  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.equal(report.failed.length, 0);
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0].outputs.length, 2);

  for (const output of report.files[0].outputs) {
    await fs.access(path.resolve(process.cwd(), output.path));
  }

  const saved = JSON.parse(await fs.readFile(manifest, 'utf8'));
  assert.equal(saved.version, 4);
  assert.equal(saved.files.length, 1);
  assert.deepEqual(
    saved.files[0].outputs.map((output) => output.width),
    [100, 200],
  );
  assert.match(saved.files[0].srcset.webp, /photo-100\.webp 100w/);
  assert.equal(saved.totals.files, 1);
});

test('cli exits 1 when an input cannot be read', async (t) => {
  const dir = await tempDir(t);
  const missing = path.join(dir, 'nope.jpg');

  await assert.rejects(
    exec(process.execPath, [path.join(root, 'src', 'cli.js'), missing, '-o', path.join(dir, 'out')]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /not found/);
      return true;
    },
  );
});

test('quality actually changes encoded size', async () => {
  const buffer = await sharp(noise(400, 300), { raw: { width: 400, height: 300, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();

  const high = await transcode(buffer, { format: 'webp', quality: 90 });
  const low = await transcode(buffer, { format: 'webp', quality: 10 });

  assert.equal(low.info.quality, 10);
  assert.equal(high.info.quality, 90);
  assert.ok(low.data.length < high.data.length, `${low.data.length} should be < ${high.data.length}`);
});

test('glob inputs expand and mirror their static root', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  await makeJpeg(path.join(source, 'hero.jpg'), 200, 100);
  await makeNoise(path.join(source, 'team', 'ana.png'), 100, 100, 'png');
  const out = path.join(dir, 'out');

  const result = await optimize([path.join(source, '**/*.{jpg,png}')], {
    outDir: out,
    formats: ['webp'],
  });

  assert.equal(result.failed.length, 0);
  assert.equal(result.files.length, 2);
  await fs.access(path.join(out, 'hero.webp'));
  await fs.access(path.join(out, 'team', 'ana.webp'));
});

test('include and exclude filters work recursively', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  await makeJpeg(path.join(source, 'keep.jpg'), 120, 80);
  await makeJpeg(path.join(source, 'nested', 'draft-one.jpg'), 120, 80);
  await makeJpeg(path.join(source, 'icon.png'), 120, 80);
  const out = path.join(dir, 'out');

  const result = await optimize([source], {
    outDir: out,
    formats: ['webp'],
    recursive: true,
    include: ['*.jpg'],
    exclude: ['draft-*'],
  });

  assert.equal(result.failed.length, 0);
  assert.deepEqual(result.files.map((file) => path.basename(file.input)), ['keep.jpg']);
  await fs.access(path.join(out, 'keep.webp'));
  await assert.rejects(fs.access(path.join(out, 'icon.webp')));
});

test('prefix, suffix, hash, rotate, cover and extend all apply', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'photo.jpg');
  await makeNoise(input, 240, 120);
  const out = path.join(dir, 'out');

  const result = await optimize([input], {
    outDir: out,
    formats: ['webp'],
    width: 60,
    height: 60,
    fit: 'cover',
    rotate: 90,
    extend: 5,
    prefix: 'pre-',
    suffix: '-mid',
    hash: true,
  });

  assert.equal(result.failed.length, 0);
  const output = result.files[0].outputs[0];
  assert.match(path.basename(output.path), /^pre-photo-mid-[0-9a-f]{8}\.webp$/);
  assert.equal(output.width, 70);
  assert.equal(output.height, 70);
  const meta = await sharp(output.path).metadata();
  assert.equal(meta.width, 70);
  assert.equal(meta.height, 70);
});

test('maxBytes lowers quality until each variant fits', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'photo.jpg');
  await makeNoise(input, 500, 400);
  const out = path.join(dir, 'out');

  const result = await optimize([input], {
    outDir: out,
    formats: ['jpeg'],
    quality: 95,
    maxBytes: 12_000,
  });

  assert.equal(result.failed.length, 0);
  const output = result.files[0].outputs[0];
  assert.ok(output.bytes <= 12_000);
  assert.ok(output.quality < 95);
  const stat = await fs.stat(output.path);
  assert.equal(stat.size, output.bytes);
});

test('cache skips unchanged files and invalidates on option changes', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'photo.jpg');
  await makeJpeg(input, 200, 100);
  const out = path.join(dir, 'out');
  const cacheDir = path.join(dir, 'cache');
  const options = { outDir: out, formats: ['webp'], cache: true, cacheDir };

  const first = await optimize([input], options);
  assert.equal(first.files[0].cached, false);
  assert.equal(first.totals.cached, 0);
  assert.equal((await fs.readdir(cacheDir)).length, 1);
  await assert.rejects(fs.access(path.join(out, '.pixelpress-cache.json')));

  const second = await optimize([input], options);
  assert.equal(second.files[0].cached, true);
  assert.equal(second.totals.cached, 1);

  // A 0.3 cache inside the output dir is migrated once and then removed.
  const [cacheName] = await fs.readdir(cacheDir);
  const cachePath = path.join(cacheDir, cacheName);
  const legacyPath = path.join(out, '.pixelpress-cache.json');
  await fs.copyFile(cachePath, legacyPath);
  await fs.rm(cachePath);
  const migrated = await optimize([input], options);
  assert.equal(migrated.files[0].cached, true);
  await assert.rejects(fs.access(legacyPath));
  assert.equal((await fs.readdir(cacheDir)).length, 1);

  const changed = await optimize([input], { ...options, quality: 20 });
  assert.equal(changed.files[0].cached, false);

  const forced = await optimize([input], { ...options, quality: 20, force: true });
  assert.equal(forced.files[0].cached, false);
});

test('clean removes stale output but refuses unsafe directories', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'src', 'photo.jpg');
  await makeJpeg(input, 100, 80);
  const out = path.join(dir, 'out');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'stale.txt'), 'stale');

  await optimize([input], { outDir: out, formats: ['webp'], clean: true });
  await assert.rejects(fs.access(path.join(out, 'stale.txt')));
  await fs.access(path.join(out, 'photo.webp'));

  await assert.rejects(
    optimize([path.join(dir, 'src')], { outDir: path.join(dir, 'src'), formats: ['webp'], clean: true }),
    /differ/,
  );
  await assert.rejects(
    optimize([path.join(dir, 'src')], { outDir: dir, formats: ['webp'], clean: true }),
    /refusing to clean/,
  );
});

test('lqip adds a tiny placeholder and dominant color', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'photo.jpg');
  await makeJpeg(input, 160, 100);

  const result = await optimize([input], {
    outDir: path.join(dir, 'out'),
    formats: ['webp'],
    lqip: true,
  });

  assert.equal(result.failed.length, 0);
  assert.match(result.files[0].placeholder, /^data:image\/webp;base64,/);
  assert.match(result.files[0].dominantColor, /^#[0-9a-f]{6}$/);
});

test('cli reads a config and writes picture snippets', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  await makeJpeg(path.join(source, 'photo.jpg'), 300, 200);
  const out = path.join(dir, 'out');
  const picture = path.join(dir, 'picture.html');
  const reportPath = path.join(dir, 'report.html');
  const config = path.join(dir, 'pixelpress.config.json');
  await fs.writeFile(config, JSON.stringify({
    inputs: [source],
    outDir: out,
    formats: ['avif', 'webp'],
    widths: [100, 200],
    prefix: 'cfg-',
    cache: false,
    manifest: path.join(dir, 'manifest.json'),
    picture,
    report: reportPath,
    publicPath: '/img',
    sizes: '50vw',
  }));

  const { stdout } = await exec(process.execPath, [
    path.join(root, 'src', 'cli.js'),
    '--config', config,
    '--json',
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.failed.length, 0);
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0].outputs.length, 4);

  const html = await fs.readFile(picture, 'utf8');
  assert.match(html, /<source type="image\/avif"/);
  assert.match(html, /\/img\/cfg-photo-100\.avif 100w/);
  assert.match(html, /sizes="50vw"/);
  assert.match(html, /<img src="\/img\/cfg-photo-200\.webp"/);
  await fs.access(path.join(dir, 'manifest.json'));

  const htmlReport = await fs.readFile(reportPath, 'utf8');
  assert.match(htmlReport, /<article class="card">/);
  assert.match(htmlReport, /cfg-photo-200\.webp/);
  assert.match(htmlReport, /smaller|larger/);

  const leftovers = await fs.readdir(dir, { recursive: true });
  assert.deepEqual(leftovers.filter((entry) => entry.endsWith('.tmp')), []);
});

test('cli dry run writes no images, manifest, or picture file', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  await makeJpeg(path.join(source, 'photo.jpg'), 120, 80);
  const out = path.join(dir, 'out');
  const manifest = path.join(dir, 'manifest.json');
  const picture = path.join(dir, 'picture.html');
  const htmlReport = path.join(dir, 'report.html');

  const { stdout } = await exec(process.execPath, [
    path.join(root, 'src', 'cli.js'),
    source,
    '--out', out,
    '--formats', 'webp',
    '--dry-run',
    '--manifest', manifest,
    '--picture', picture,
    '--report', htmlReport,
    '--json',
  ]);

  const report = JSON.parse(stdout);
  assert.equal(report.options.dryRun, true);
  assert.equal(report.totals.outputs, 1);
  assert.equal(report.totals.outputBytes, null);
  await assert.rejects(fs.access(out));
  await assert.rejects(fs.access(manifest));
  await assert.rejects(fs.access(picture));
  await assert.rejects(fs.access(htmlReport));
});

test('animated frames are preserved in webp and fall back to the first frame', async (t) => {
  const dir = await tempDir(t);
  const frameA = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const frameB = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer();
  const animated = path.join(dir, 'loop.gif');
  await sharp([frameA, frameB], { join: { animated: true } }).gif().toFile(animated);

  const result = await optimize([animated], {
    outDir: path.join(dir, 'out'),
    formats: ['webp', 'avif'],
    widths: [20],
  });

  assert.equal(result.failed.length, 0);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].height, 40);

  const webp = result.files[0].outputs.find((output) => output.format === 'webp');
  const avif = result.files[0].outputs.find((output) => output.format === 'avif');
  assert.equal(webp.animated, true);
  assert.equal(webp.pages, 2);
  assert.equal(webp.width, 20);
  assert.equal(webp.height, 20);
  const webpMeta = await sharp(webp.path, { animated: true }).metadata();
  assert.equal(webpMeta.pages, 2);
  assert.equal(webpMeta.pageHeight, 20);

  assert.equal(avif.animated, false);
  assert.equal(avif.pages, 1);
  assert.equal(avif.height, 20);
  const avifMeta = await sharp(avif.path, { animated: true }).metadata();
  assert.equal(avifMeta.pages, 1);

  const transcoded = await transcode(await fs.readFile(animated), { format: 'webp', width: 20 });
  assert.equal(transcoded.info.animated, true);
  assert.equal(transcoded.info.pages, 2);
  assert.equal(transcoded.info.height, 20);
});

test('failFast stops after the first failed file', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'a-broken.jpg'), 'not an image');
  await makeJpeg(path.join(source, 'b-good.jpg'), 100, 80);
  const out = path.join(dir, 'out');

  const failed = await optimize([source], { outDir: out, formats: ['webp'], failFast: true });
  assert.equal(failed.failed.length, 1);
  assert.equal(failed.files.length, 0);
  await assert.rejects(fs.access(path.join(out, 'b-good.webp')));

  const continued = await optimize([source], { outDir: path.join(dir, 'out2'), formats: ['webp'] });
  assert.equal(continued.failed.length, 1);
  assert.equal(continued.files.length, 1);
  await fs.access(path.join(dir, 'out2', 'b-good.webp'));
});

test('watch re-encodes when an input changes', { timeout: 20_000 }, async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'src', 'photo.jpg');
  await makeJpeg(input, 160, 120);
  const out = path.join(dir, 'out');
  const output = path.join(out, 'photo.webp');

  const child = spawn(process.execPath, [
    path.join(root, 'src', 'cli.js'),
    path.join(dir, 'src'),
    '--out', out,
    '--formats', 'webp',
    '--watch',
    '--quiet',
  ], { stdio: 'ignore' });

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });

  await waitFor(async () => {
    try {
      await fs.access(output);
      return true;
    } catch {
      return false;
    }
  });
  const before = await fs.stat(output);

  await new Promise((resolve) => setTimeout(resolve, 500));
  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ff3300' } })
    .jpeg({ quality: 90 })
    .toFile(input);
  const now = new Date();
  await fs.utimes(input, now, now);

  await waitFor(async () => {
    const after = await fs.stat(output);
    return after.size !== before.size || after.mtimeMs > before.mtimeMs;
  });

  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
});

test('cli streams one image to stdout from a file and stdin', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'photo.jpg');
  await makeNoise(input, 240, 160);

  async function runStream(args, stdin) {
    const child = spawn(process.execPath, [path.join(root, 'src', 'cli.js'), ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
    const code = await new Promise((resolve) => child.on('close', resolve));
    return { code, data: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() };
  }

  const fromFile = await runStream([input, '-f', 'webp', '--stdout', '--width', '80', '--quiet']);
  assert.equal(fromFile.code, 0);
  assert.equal(fromFile.stderr, '');
  const fileMeta = await sharp(fromFile.data).metadata();
  assert.equal(fileMeta.format, 'webp');
  assert.equal(fileMeta.width, 80);

  const fromStdin = await runStream(['-', '-f', 'webp', '--stdout', '--width', '60', '--quiet'], await fs.readFile(input));
  assert.equal(fromStdin.code, 0);
  assert.equal(fromStdin.stderr, '');
  const stdinMeta = await sharp(fromStdin.data).metadata();
  assert.equal(stdinMeta.format, 'webp');
  assert.equal(stdinMeta.width, 60);
});

test('prune removes stale variants and deleted sources, but keeps failed outputs', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  const a = path.join(source, 'a.jpg');
  const b = path.join(source, 'team', 'b.jpg');
  await makeJpeg(a, 300, 200);
  await makeJpeg(b, 300, 200);
  const out = path.join(dir, 'out');
  const cacheDir = path.join(dir, 'cache');
  const common = { outDir: out, cache: true, cacheDir, prune: true, recursive: true };

  const first = await optimize([source], {
    ...common,
    formats: ['webp', 'avif'],
    widths: [100, 200],
  });
  assert.equal(first.totals.outputs, 8);
  assert.equal(first.totals.pruned, 0);
  await fs.access(path.join(out, 'a-200.avif'));
  await fs.access(path.join(out, 'team', 'b-100.webp'));

  await fs.rm(b);
  const second = await optimize([source], {
    ...common,
    formats: ['webp'],
    widths: [100],
  });
  assert.equal(second.files.length, 1);
  assert.equal(second.totals.outputs, 1);
  assert.equal(second.totals.pruned, 7);
  await fs.access(path.join(out, 'a-100.webp'));
  for (const stale of [
    'a-100.avif', 'a-200.webp', 'a-200.avif',
    'team/b-100.webp', 'team/b-100.avif', 'team/b-200.webp', 'team/b-200.avif',
  ]) {
    await assert.rejects(fs.access(path.join(out, stale)), `${stale} should be pruned`);
  }
  await assert.rejects(fs.access(path.join(out, 'team')));

  await fs.writeFile(a, 'not an image');
  const third = await optimize([source], {
    ...common,
    formats: ['webp'],
    widths: [100],
  });
  assert.equal(third.failed.length, 1);
  assert.equal(third.totals.pruned, 0);
  await fs.access(path.join(out, 'a-100.webp'));

  await fs.rm(a);
  const fourth = await optimize([source], {
    ...common,
    formats: ['webp'],
    widths: [100],
  });
  assert.equal(fourth.files.length, 0);
  assert.equal(fourth.totals.pruned, 1);
  await assert.rejects(fs.access(path.join(out, 'a-100.webp')));

  const entries = await fs.readdir(dir, { recursive: true });
  assert.deepEqual(entries.filter((entry) => entry.endsWith('.tmp')), []);

  await assert.rejects(
    optimize([source], { outDir: out, formats: ['webp'], cache: false, prune: true }),
    /prune requires cache/,
  );
});

test('failed multi-format runs roll back only newly created outputs', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src', 'a.jpg');
  await makeJpeg(source, 160, 120);

  const firstOut = path.join(dir, 'first');
  await fs.mkdir(path.join(firstOut, 'a.jpg'), { recursive: true });
  const first = await optimize([source], {
    outDir: firstOut,
    formats: ['webp', 'jpeg'],
    cache: false,
  });
  assert.equal(first.failed.length, 1);
  await assert.rejects(fs.access(path.join(firstOut, 'a.webp')));
  assert.equal((await fs.stat(path.join(firstOut, 'a.jpg'))).isDirectory(), true);

  const secondOut = path.join(dir, 'second');
  await fs.mkdir(path.join(secondOut, 'a.jpg'), { recursive: true });
  await fs.writeFile(path.join(secondOut, 'a.webp'), 'previous output');
  const second = await optimize([source], {
    outDir: secondOut,
    formats: ['webp', 'jpeg'],
    cache: false,
  });
  assert.equal(second.failed.length, 1);
  await fs.access(path.join(secondOut, 'a.webp'));
  assert.equal((await fs.stat(path.join(secondOut, 'a.jpg'))).isDirectory(), true);

  const leftovers = await fs.readdir(dir, { recursive: true });
  assert.deepEqual(leftovers.filter((entry) => entry.endsWith('.tmp')), []);
});

test('presets set defaults and explicit options override them', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'large.jpg');
  await makeJpeg(input, 2400, 1600);

  const web = await optimize([input], { outDir: path.join(dir, 'web'), preset: 'web', cache: false });
  assert.equal(web.options.preset, 'web');
  assert.deepEqual(web.options.widths, [480, 960, 1920]);
  assert.equal(web.files[0].outputs.length, 6);
  assert.deepEqual([...new Set(web.files[0].outputs.map((output) => output.width))], [480, 960, 1920]);

  const overridden = await optimize([input], {
    outDir: path.join(dir, 'overridden'),
    preset: 'web',
    formats: ['webp'],
    widths: [640],
    cache: false,
  });
  assert.equal(overridden.files[0].outputs.length, 1);
  assert.equal(overridden.files[0].outputs[0].width, 640);

  const thumb = await optimize([input], {
    outDir: path.join(dir, 'thumb'),
    preset: 'thumb',
    width: 300,
    cache: false,
  });
  assert.equal(thumb.files[0].outputs[0].width, 300);

  await assert.rejects(
    optimize([input], { outDir: path.join(dir, 'bad'), preset: 'nope' }),
    /unknown preset/,
  );
});

test('cli init writes a config and refuses to overwrite it', async (t) => {
  const dir = await tempDir(t);
  const cli = path.join(root, 'src', 'cli.js');

  const { stdout } = await exec(process.execPath, [cli, '--init'], { cwd: dir });
  assert.match(stdout, /created/);
  const config = JSON.parse(await fs.readFile(path.join(dir, 'pixelpress.config.json'), 'utf8'));
  assert.equal(config.preset, 'web');
  assert.match(config.$schema, /pixelpress\.schema\.json$/);

  await assert.rejects(
    exec(process.execPath, [cli, '--init'], { cwd: dir }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /already exists/);
      return true;
    },
  );
});

test('beforeEncode hook can composite a watermark', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'photo.jpg');
  await makeJpeg(input, 400, 300);
  const mark = await sharp({ create: { width: 80, height: 30, channels: 4, background: { r: 201, g: 255, b: 61, alpha: 1 } } }).png().toBuffer();

  const plain = await optimize([input], { outDir: path.join(dir, 'plain'), formats: ['webp'], cache: false });
  const marked = await optimize([input], {
    outDir: path.join(dir, 'marked'),
    formats: ['webp'],
    cache: false,
    hooks: { beforeEncode: (pipeline) => pipeline.composite([{ input: mark, gravity: 'southeast' }]) },
  });

  assert.equal(marked.failed.length, 0);
  assert.equal(marked.files[0].outputs[0].width, 400);
  assert.equal(marked.files[0].outputs[0].height, 300);
  const before = await fs.readFile(plain.files[0].outputs[0].path);
  const after = await fs.readFile(marked.files[0].outputs[0].path);
  assert.ok(!before.equals(after), 'watermarked bytes should differ');
});

test('afterEncode hook can replace bytes and applies without hash or maxBytes', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'photo.jpg');
  await makeJpeg(input, 200, 100);

  const result = await optimize([input], {
    outDir: path.join(dir, 'out'),
    formats: ['webp'],
    cache: false,
    hooks: { afterEncode: async ({ data }) => data.subarray(0, 64) },
  });

  assert.equal(result.failed.length, 0);
  const output = result.files[0].outputs[0];
  assert.equal(output.bytes, 64);
  assert.equal((await fs.stat(output.path)).size, 64);

  const transcoded = await transcode(await fs.readFile(input), {
    format: 'webp',
    hooks: { afterEncode: ({ data }) => data.subarray(0, 32) },
  });
  assert.equal(transcoded.data.length, 32);
  assert.equal(transcoded.info.bytes, 32);
});

test('changing hooks invalidates the cache; invalid hooks throw', async (t) => {
  const dir = await tempDir(t);
  const input = path.join(dir, 'photo.jpg');
  await makeJpeg(input, 200, 100);
  const common = { outDir: path.join(dir, 'out'), formats: ['webp'], cache: true, cacheDir: path.join(dir, 'cache') };

  const first = await optimize([input], { ...common, hooks: { beforeEncode: (pipeline) => pipeline } });
  assert.equal(first.files[0].cached, false);
  const second = await optimize([input], { ...common, hooks: { beforeEncode: (pipeline) => pipeline } });
  assert.equal(second.files[0].cached, true);
  const changed = await optimize([input], {
    ...common,
    hooks: { beforeEncode: (pipeline) => pipeline.grayscale() },
  });
  assert.equal(changed.files[0].cached, false);

  await assert.rejects(
    optimize([input], { ...common, hooks: { beforeEncode: 'nope' } }),
    /hooks\.beforeEncode must be a function/,
  );
  await assert.rejects(
    optimize([input], { ...common, hooks: 'nope' }),
    /hooks must be an object/,
  );
});
