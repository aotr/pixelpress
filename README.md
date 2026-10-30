# pixelpress

**Press images into next-gen formats.** Compress JPEG, PNG, WebP, AVIF, TIFF,
GIF, and SVG into AVIF, WebP, JPEG, or PNG — with responsive widths, a JSON
manifest, and no interactive prompts.

```bash
npx pixelpress public/images -o dist/images --recursive
```

```
pixelpress public/images → /app/dist/images (avif,webp)
  ✓ hero.jpg          1.4 MB → 182.3 KB  87% smaller
  ✓ team/ana.png      420.1 KB → 61.8 KB  85% smaller
  ✓ icon.svg          12.4 KB → 3.1 KB   75% smaller

3 files · 6 outputs · 1.8 MB → 247.2 KB (86% smaller) · 1.2s
```

## Why another image tool?

`pixelpress` is a ground-up rebuild of
[SudiptoImgTranscode](https://www.npmjs.com/package/sudipto-img-transcode).
Same idea — batch-convert images to modern formats — without the sharp edges:

| Original | pixelpress |
| --- | --- |
| JPG only, top-level folder only | Any format sharp reads, recursive with `-r` |
| Interactive prompts | Flags, usable in CI |
| One quality for every format | Sensible per-format defaults, override per format |
| No resizing | `--widths 480,960,1920` for `srcset`, never upscales |
| `main` runs the CLI on import | Clean `optimize()` / `transcode()` API |
| Swallowed errors | Per-file failures and exit code 1 |
| Alpha PNG → JPEG breaks | Flattens transparency onto `--background` |
| EXIF rotation ignored | Auto-orients before encoding |
| No way to wire output into markup | `--manifest images.json` |
| One image at a time | Bounded parallelism (`--concurrency`) |
| Format subfolders (`out/webp/x.webp`) | Mirrors the input tree, predictable names |

## Install

```bash
npm install --save-dev pixelpress
```

Requires Node.js 20+. The only dependency is `sharp`.

## CLI

```bash
pixelpress <file|dir...> [options]

  -o, --out <dir>          output directory                (default: pixelpress-out)
  -f, --formats <list>     avif, webp, jpeg, png            (default: avif,webp)
  -q, --quality <value>    1-100, or avif=55,webp=78        (default: avif 55, webp 78, jpeg 80, png 80)
  -w, --widths <list>      responsive widths, e.g. 480,960,1920
  -r, --recursive          include subdirectories
      --flat               flatten the output tree (fails on duplicate names)
      --concurrency <n>    files processed in parallel      (default: 4)
      --background <color> matte for transparent JPEGs      (default: #ffffff)
      --keep-metadata      keep EXIF/ICC instead of stripping it
      --manifest <file>    write a JSON report of every variant
      --dry-run            show the plan without writing files
      --json               print the full report as JSON
  -h, --help
  -v, --version
```

### Examples

```bash
# One responsive set, AVIF + WebP
pixelpress hero.jpg -o dist -f avif,webp -w 480,960,1920
# → dist/hero-480.avif, dist/hero-960.webp, ...

# Whole asset tree, per-format quality, manifest for your build
pixelpress public/images -o dist/images -r \
  -q avif=50,webp=72 -w 320,640,1280 \
  --manifest dist/images.json

# Preview without touching disk
pixelpress public/images -o dist -r --dry-run

# Machine-readable run for CI
pixelpress public/images -o dist --json > report.json
```

Output keeps your folder structure:

```
public/images/            dist/images/
  hero.jpg                  hero.avif
  team/ana.png              hero.webp
                            team/ana.avif
                            team/ana.webp
```

`--widths` appends the width to filenames (`hero-480.avif`). Widths larger than
the source are skipped, so a 500px image never becomes a blurry 1280px file.

### Defaults

| Format | Quality | Notes |
| --- | --- | --- |
| AVIF | 55 | Best compression; roughly JPEG-80 visual quality |
| WebP | 78 | Broad support, fast |
| JPEG | 80 | `mozjpeg`, progressive |
| PNG | 80 | Palette quantization at quality < 100; `png=100` is lossless |

Metadata (EXIF, GPS, ICC) is stripped by default, which also removes privacy
leaks. Pass `--keep-metadata` to keep it. EXIF orientation is always applied,
so portrait photos stay upright.

### Manifest

`--manifest` writes a compact report you can consume from templates or build
steps:

```json
{
  "generatedAt": "2026-10-30T10:00:00.000Z",
  "options": { "formats": ["avif", "webp"], "widths": [480], "...": "..." },
  "files": [
    {
      "input": "public/images/hero.jpg",
      "width": 2400,
      "height": 1600,
      "sourceBytes": 1436544,
      "outputs": [
        { "format": "avif", "path": "dist/images/hero-480.avif", "width": 480, "height": 320, "bytes": 14210 },
        { "format": "webp", "path": "dist/images/hero-480.webp", "width": 480, "height": 320, "bytes": 22981 }
      ]
    }
  ],
  "skipped": [],
  "failed": [],
  "totals": {
    "files": 1,
    "outputs": 2,
    "sourceBytes": 1436544,
    "outputBytes": 37191,
    "savedBytes": 1399353,
    "savedPercent": 97,
    "skipped": 0,
    "failed": 0,
    "durationMs": 842
  }
}
```

Paths are relative to the current working directory.

## API

### `optimize(inputs, options)`

```js
import { optimize } from 'pixelpress';

const report = await optimize(['public/images'], {
  outDir: 'dist/images',
  formats: ['avif', 'webp'],
  widths: [480, 960],
  quality: { avif: 50, webp: 72 }, // or a single number for all formats
  recursive: true,
  concurrency: 4,
  background: '#ffffff',
  flat: false,
  dryRun: false,
  keepMetadata: false,
});

console.log(report.totals.savedPercent, '% smaller');
for (const file of report.files) {
  for (const variant of file.outputs) {
    console.log(variant.path, variant.width, variant.bytes);
  }
}
```

Every path in the result is absolute. Processing continues when a single file
fails; inspect `report.failed`. A colliding output path (possible with `flat`)
fails that file instead of silently overwriting the other one.

### `transcode(input, options)`

Encode one image from a path, `Buffer`, or `Uint8Array`:

```js
import { transcode } from 'pixelpress';

const { data, info } = await transcode('upload.jpg', {
  format: 'avif',
  width: 800,
  quality: 50,
});

// data is a Buffer; info = { format, width, height, bytes, sourceWidth }
await fs.writeFile('upload.avif', data);
```

Useful in an upload handler or a build plugin. Pass a buffer to avoid touching
disk.

## Behavior and guarantees

- **Never overwrites the input.** `--out` must differ from every input
  directory, and an output that resolves to an input file is refused.
- **No upscaling.** Requested widths above the source width are dropped.
- **Output collisions are errors.** Two inputs mapping to the same output path
  are reported, not silently lost.
- **Partial failure is visible.** Bad files land in `failed`, good files are
  still written, and the CLI exits `1`.
- **No stale cache.** Every run re-encodes, so changing quality always takes
  effect. (Incremental caching is on the roadmap.)
- **Animated images are skipped** with a clear reason, rather than silently
  losing frames. Support is planned for 0.2.

## Development

```bash
npm install
npm test
```

`PLAN.md` contains the audit, naming rationale, and roadmap (watch mode,
content hashing, incremental cache, responsive HTML snippets, framework
plugins).

## License

MIT
