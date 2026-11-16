# pixelpress — plan

> Press images into next-gen formats. Fast, scriptable, no prompts.

## Why the name

`sudipto-img-transcode` described a person and a mechanism, not the job.
`pixelpress` is short, spellable, unclaimed on npm, and says the outcome:
images getting smaller. Binary and package share the name.

## The original

53 lines. It walked one folder, kept `.jpg` only, asked three questions in a
terminal, and wrote `out/{png,webp,avif}/name.ext` at one quality for all three
formats.

## 0.1 audit → what shipped

| Problem in the original | Fix in 0.1 |
| --- | --- |
| `main` ran the CLI on import | `src/index.js` is the library; CLI is separate |
| JPG only, non-recursive | Any sharp-readable input; recursive and glob inputs |
| One quality for every format | Per-format defaults and `--quality avif=50,webp=72` |
| No resizing | `--widths`, never upscales |
| Errors swallowed | Per-file failures, exit code 1 |
| One image at a time | Bounded concurrency |
| Format subfolders | Mirrors the input tree |
| Alpha PNG → JPEG breaks | Flattens onto `--background` |
| EXIF rotation ignored | Auto-orients before encoding |
| No manifest | `--manifest` JSON |
| GPL/MIT contradiction | MIT throughout |
| Interactive prompts only | Flags + programmatic API |
| No tests | `node:test` suite |

## 0.2 — the kitchen sink (shipped)

Researched sharp-cli, imagemin-cli, Squoosh CLI, vite-imagetools, and
eleventy-img. See `COMPARISON.md` for the matrix.

### Bulk

- Quoted glob inputs (`"images/**/*.{jpg,png}"`) using Node's glob engine.
- `--include` / `--exclude` filters (repeatable, basename + relative path).
- `--follow-symlinks`, recursive walks, multiple inputs, collision detection.
- Config file (`pixelpress.config.json`, JSON or ESM), CLI overrides.
- `--clean` with guards against root/home/cwd/input destruction.
- Cache (`--cache`, on by default) keyed by input mtime/size and an options
  fingerprint; `--force` and `--no-cache`.
- `--watch` with debounce, output-event filtering, and cache-backed reruns.
- `--preserve-dates`.

### Output

- `--width`/`--height`/`--fit`/`--position` for single-target resizes.
- Responsive `--widths` sets, no upscaling.
- `--prefix`, `--suffix`, `--hash` (content hash), `--flat`.
- `--max-bytes` per-variant quality search.
- `--lqip` placeholder + dominant color.
- `--manifest` with cached state, quality used, and LQIP fields.
- `--picture` snippet generation with `--public-path` and `--sizes`.

### Transforms

`rotate`, auto-orient toggle, `flip`/`flop`, `grayscale`, `blur`, `sharpen`,
`normalize`, `gamma`, `tint`, `trim`, `extract`, `extend`, `density`.

### Encoding

Per-format quality and effort, `lossless`, `progressive`, chroma subsampling,
WebP alpha quality, PNG palette/compression level, metadata retention,
background matte.

### Workflow

`--json`, `--dry-run`, `--quiet`, `--verbose`, `--fail-fast`,
`--concurrency`, nameable manifests, config-driven runs, HTML reports, and
stdin/stdout piping.

## 0.3 — shipped

- **Animated WebP**: frames are preserved for animated GIF/WebP inputs,
  including resized width variants. AVIF/JPEG/PNG use the first frame as a
  static fallback. `<picture>` puts the animated source first.
- **HTML report**: `--report` writes a self-contained before/after gallery with
  byte deltas, dimensions, quality, frames, and cache state.
- **stdin/stdout**: `cat image.png | pixelpress - -f webp --stdout > out.webp`,
  with all transforms and size budgets intact.
- Cache version bumped for the new output shape.

## 0.4 — shipped

- **Prune**: `--prune` deletes outputs recorded in the cache that are no longer
  produced. It removes empty directories, never deletes inputs, and keeps
  outputs for failed files and fail-fast leftovers.
- **Cache relocation**: cache files now live in
  `node_modules/.cache/pixelpress/cache-<outDir-hash>.json`, outside deployable
  output. `--cache-dir` and `PIXELPRESS_CACHE_DIR` override the location.
  0.3 caches inside `outDir` are migrated once and removed.
- **Atomic writes**: images, manifests, picture files, reports, and cache files
  are written to a temp file and renamed, so interruption cannot leave a
  partial final file.
- **CI**: GitHub Actions tests Node 22/24 on Ubuntu and macOS.
- **Trusted publishing**: a manual `Publish` workflow uses npm OIDC and
  `--provenance`; configure the trusted publisher on npmjs.com first.

## 0.5

- **Animated AVIF** when sharp/libvips exposes reliable frame output.
- **Perceptual quality targeting**: a Butteraugli/SSIM option in addition to
  `--max-bytes`.
- **Framework adapters**: Vite plugin, Next.js loader, Astro integration.
- **Plugin hooks**: optional pre/post transform functions for the API (e.g.
  watermarking).
- **Better watch fallback**: chokidar-style recursive watching on platforms
  without recursive `fs.watch`, plus config-file reloads.
- **Partial-run recovery**: clean up already-written variants when one format
  in a multi-format run fails.
- **Onboarding**: `pixelpress --init` and a JSON Schema for
  `pixelpress.config.json`.
- **Presets**: `--preset web|thumb|social|lossless` over the option surface.

## Non-goals

- A GUI. The CLI is the product; a viewer adds no compression.
- Upload/CDN integration. Keep the tool local and boring.
- Replacing sharp. Sharp is the engine; pixelpress is the ergonomics.
- A general image editor. Transforms cover web delivery, not creative editing.

## Quality bar

- 25 `node:test` cases cover API, globs, filters, quality, transforms, max
  bytes, cache invalidation and migration, pruning, atomic temp cleanup, clean
  safety, LQIP, config, srcset, animated frames, reports, stdout, collisions,
  alpha flattening, EXIF orientation, and CLI behavior.
- Every option appears in `--help` and the README.
- Dry runs touch nothing. Clean refuses unsafe paths. Output never overwrites
  an input. Prune only deletes cached outputs inside the output directory.
