# pixelpress — plan

> Press images into next-gen formats. Fast, scriptable, no prompts.

## Why rename

`sudipto-img-transcode` described a person and a mechanism, not the job.
`pixelpress` is short, spellable, free on npm, and says the outcome: images
getting smaller. Binary and package share the name.

## What the original does

53 lines. It walks one folder, keeps `.jpg` only, asks three questions in a
terminal, and writes `out/{png,webp,avif}/name.ext` at one quality for all
three formats. That's the whole product.

## Audit

| Problem | Impact | Fix in pixelpress |
|---|---|---|
| `main` points at `app.js`, which runs the CLI on import | Unusable as a library | `src/index.js` is the entry; CLI is separate |
| JPG only, non-recursive | Most real asset folders fail | Any sharp-readable input, `-r` for trees |
| One quality for AVIF/WebP/PNG | AVIF 80 wastes bytes; PNG quality is ignored unless paletted | Per-format quality defaults, `--quality avif=50,webp=75` |
| No resizing | Can't produce `srcset` | `--widths`, never upscales |
| Errors swallowed with `console.error` | Scripts can't tell success from failure | Per-file failures in the result, exit code 1 |
| `await` in nested loops | One image at a time | Bounded file concurrency |
| Format subfolders, guessed paths | Hard to map output back to input | Mirrors input tree, predictable names |
| Alpha PNG → JPEG throws or turns black | Broken builds | Flattens onto `--background` |
| EXIF rotation ignored | Portrait photos come out sideways | Auto-orient via `sharp.rotate()` |
| No manifest | No way to wire outputs into templates | `--manifest` JSON |
| README says GPL, package says MIT | Legal ambiguity | MIT throughout |
| Interactive prompts only | No CI/scripts | Flags + programmatic API |
| No tests | Regressions ship | `node:test` suite |

## More ideas, ranked by value per line of code

### Now (0.1, in this build)

- **Per-format defaults** that are actually good: AVIF 55, WebP 78, JPEG 80.
- **`--manifest`** with dimensions, bytes, and savings per variant.
- **`--dry-run`** to see the plan before writing.
- **`--json`** for CI and other tools.
- **`transcode()` buffer API** for servers and build plugins.
- **Any-to-any input** (JPEG, PNG, WebP, AVIF, TIFF, GIF frame, SVG).
- **Safe output**: refuses to overwrite an input, detects flat-name collisions.
- **Human summary** with real byte savings and elapsed time.

### Next (0.2)

- `--watch`: re-encode changed files, debounce bursts.
- Incremental cache keyed by input mtime + options hash, so changing quality
  invalidates correctly instead of silently serving stale output.
- Content-hashed filenames (`hero.a1b2c3.avif`) for immutable caching.
- Animated GIF/WebP/AVIF passthrough with per-frame resize.
- `--max-bytes`: step quality down until the variant fits a budget.
- HTML `<picture>` / `srcset` snippet generation from the manifest.

### Later (0.3)

- Framework adapters: Vite plugin, Next.js loader, Astro integration.
- AVIF/WebP negotiation-ready output sets with a single JSON contract.
- Optional libvips tuning (`sharp.concurrency`, cache limits) for CI boxes.
- SVGO pass before rasterizing SVG inputs.

## Non-goals

- A GUI. The CLI is the product; a viewer adds no compression.
- Upload/CDN integration. Keep the tool local and boring.
- Replacing sharp. Sharp is the engine; pixelpress is the ergonomics.

## Quality bar for 0.1

- `npm test` covers API, widths, alpha flattening, collisions, buffer
  transcoding, and a real CLI run.
- Every option appears in `--help` and README.
- No hidden writes: dry-run touches nothing; output never overwrites input.
