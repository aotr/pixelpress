# How pixelpress compares

Versions checked: sharp-cli 6.1, imagemin-cli 8.0, Squoosh CLI 0.7,
vite-imagetools 12.0, @11ty/eleventy-img 7.1, pixelpress 0.5 (November 2026).

`✅` first-class, `◐` possible with extra setup, `—` not a feature.

| Capability | pixelpress | sharp-cli | imagemin-cli | Squoosh CLI | vite-imagetools | eleventy-img |
| --- | --- | --- | --- | --- | --- | --- |
| Standalone CLI | ✅ | ✅ | ✅ | ✅ | — (Vite) | — (11ty) |
| Bulk files / globs | ✅ | ✅ | ✅ | ✅ (shell) | ✅ | ✅ |
| Recursive directory input | ✅ | ✅ (glob) | ✅ (glob) | — | ✅ | ✅ |
| Include / exclude filters | ✅ | ◐ (globs) | ◐ (globs) | — | ◐ | ◐ |
| Config file | ✅ | — | — | — | ✅ (Vite) | ✅ (11ty) |
| Config scaffolding / schema | ✅ | — | — | — | — | — |
| Preset workflows | ✅ | — | — | ◐ (codecs) | — | — |
| Watch mode | ✅ | — | — | — | ✅ (Vite) | ◐ (11ty dev) |
| Incremental cache | ✅ | — | — | — | ✅ (bundler) | ◐ |
| Per-format quality | ✅ | ◐ (one value) | ✅ (plugins) | ✅ | ✅ | ✅ |
| Encoder tuning (effort, chroma, alpha) | ✅ | ✅ (full sharp) | ◐ (plugins) | ✅ (per codec) | ◐ | ◐ |
| Responsive widths | ✅ | ◐ (manual) | — | ◐ (manual) | ✅ | ✅ |
| srcset / `<picture>` output | ✅ | — | — | — | ✅ | ◐ (data only) |
| Image transforms | ✅ | ✅ (full sharp) | — | ◐ (resize/rotate) | ✅ | ◐ (sharp opts) |
| Byte-budget search | ✅ | — | — | ✅ (Butteraugli) | — | — |
| Manifest / JSON report | ✅ | ◐ (`--print`) | — | — | ◐ | ✅ (stats) |
| Visual HTML report | ✅ | — | — | — | — | — |
| stdin / stdout pipes | ✅ | ✅ | ✅ | — | — | — |
| LQIP / dominant color | ✅ | — | — | — | ◐ (blur) | — |
| Metadata stripping | ✅ default | ◐ (flag) | ◐ (plugins) | ✅ | ✅ | ✅ |
| Alpha → JPEG flatten | ✅ | ✅ (`flatten`) | — | ✅ | ◐ | ◐ |
| Bounded concurrency | ✅ | ◐ | ◐ | ✅ | ✅ | ✅ |
| Dry run | ✅ | ✅ | — | — | — | — |
| Clean output | ✅ | — | — | — | — | — |
| Stale output pruning | ✅ | — | — | — | ◐ (bundler) | — |
| Atomic output writes | ✅ | — | — | — | ◐ (bundler) | — |
| Animated input | ✅ (WebP frames) | ✅ | ◐ (plugins) | ✅ | ◐ | ◐ |
| Plugin / codec extensibility | — (planned) | ◐ | ✅ | ✅ (codecs) | ✅ | — |
| Framework integration | — (planned) | — | — | — | ✅ | ✅ |

## What pixelpress adopted

From **sharp-cli**:

- Glob inputs and a broad set of transforms (`fit`, `position`, `rotate`,
  `extract`, `extend`, `trim`, `blur`, `sharpen`, `normalize`, `gamma`, `tint`).
- Format tuning: effort, progressive JPEG, chroma subsampling, alpha quality,
  PNG palette/compression level, lossless modes.
- Dry-run and machine-readable output.

From **imagemin-cli**:

- Batch-first CLI with `--out-dir` semantics and simple piping-friendly output.
- stdin/stdout streaming for one-off conversions.
- The reminder that per-format settings should be pluggable. pixelpress exposes
  a per-format quality/effort map rather than a plugin system.

From **Squoosh CLI**:

- Per-codec quality settings and a filename suffix.
- Quality search against a target size (`--max-bytes`), though pixelpress uses
  a byte budget instead of a Butteraugli distance.
- Worker-style concurrency.

From **vite-imagetools**:

- The responsive directive idea: widths, fit, format, blur, rotate, grayscale,
  and `srcset` in one pipeline.
- Generated markup as a first-class output (`--picture`).

From **@11ty/eleventy-img**:

- Responsive output sets with predictable names and a manifest-like stats
  object.
- Metadata stripping and URL-path awareness (`--public-path`, `--sizes`).

## What pixelpress deliberately did not copy

- **Full sharp operation surface.** sharp-cli already does that well. pixelpress
  covers the transforms web images actually need and keeps a stable CLI.
- **Plugin architecture.** imagemin's plugin model is powerful but brings
  configuration overhead. A per-format option map covers the common cases.
- **WASM codecs.** Squoosh's codec breadth (JPEG XL, WebP2) is impressive, but
  libvips/sharp is faster and simpler to install. JPEG XL support can be added
  when sharp ships an encoder.
- **Bundler integration.** vite-imagetools and eleventy-img are better when you
  are already inside those tools. pixelpress is build-tool agnostic; adapters
  are on the roadmap.

## Where pixelpress is still behind

- **Animated AVIF** is not supported by the current sharp/libvips build.
  Animated WebP is preserved; other formats fall back to the first frame.
- **Bundler plugins** for Vite, Next.js, and Astro do not exist yet.
- **Quality targeting** is per-variant bytes, not a perceptual metric. A
  Butteraugli/SSIM-guided mode would be better for photos.
- **Watch fallback** is non-recursive on platforms without recursive
  `fs.watch`.

See `PLAN.md` for the path to closing these gaps.
