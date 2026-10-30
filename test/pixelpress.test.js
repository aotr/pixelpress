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
  assert.equal(saved.files.length, 1);
  assert.deepEqual(
    saved.files[0].outputs.map((output) => output.width),
    [100, 200],
  );
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

  const first = await optimize([input], { outDir: out, formats: ['webp'], cache: true });
  assert.equal(first.files[0].cached, false);
  assert.equal(first.totals.cached, 0);

  const second = await optimize([input], { outDir: out, formats: ['webp'], cache: true });
  assert.equal(second.files[0].cached, true);
  assert.equal(second.totals.cached, 1);

  const changed = await optimize([input], { outDir: out, formats: ['webp'], quality: 20, cache: true });
  assert.equal(changed.files[0].cached, false);

  const forced = await optimize([input], { outDir: out, formats: ['webp'], quality: 20, cache: true, force: true });
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
});

test('cli dry run writes no images, manifest, or picture file', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'src');
  await makeJpeg(path.join(source, 'photo.jpg'), 120, 80);
  const out = path.join(dir, 'out');
  const manifest = path.join(dir, 'manifest.json');
  const picture = path.join(dir, 'picture.html');

  const { stdout } = await exec(process.execPath, [
    path.join(root, 'src', 'cli.js'),
    source,
    '--out', out,
    '--formats', 'webp',
    '--dry-run',
    '--manifest', manifest,
    '--picture', picture,
    '--json',
  ]);

  const report = JSON.parse(stdout);
  assert.equal(report.options.dryRun, true);
  assert.equal(report.totals.outputs, 1);
  assert.equal(report.totals.outputBytes, null);
  await assert.rejects(fs.access(out));
  await assert.rejects(fs.access(manifest));
  await assert.rejects(fs.access(picture));
});

test('animated images are skipped with a reason', async (t) => {
  const dir = await tempDir(t);
  const frameA = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const frameB = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer();
  const animated = path.join(dir, 'loop.gif');
  await sharp([frameA, frameB], { join: { animated: true } }).gif().toFile(animated);

  const result = await optimize([animated], { outDir: path.join(dir, 'out'), formats: ['webp'] });

  assert.equal(result.files.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /animated/);
  await assert.rejects(
    transcode(await fs.readFile(animated), { format: 'webp' }),
    /animated/,
  );
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
