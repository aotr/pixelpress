import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { optimize, transcode } from '../src/index.js';

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
