export type OutputFormat = 'avif' | 'webp' | 'jpeg' | 'png';

export interface QualityMap {
  avif?: number;
  webp?: number;
  jpeg?: number;
  png?: number;
}

export interface EffortMap {
  avif?: number;
  webp?: number;
  png?: number;
}

export type FitMode = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
export type PresetName = 'web' | 'thumb' | 'social' | 'lossless';

export interface ExtractOptions {
  width: number;
  height: number;
  left?: number;
  top?: number;
}

export interface ExtendOptions {
  all?: number;
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface OptimizeOptions {
  /** Directory for encoded files. Default: pixelpress-out */
  outDir?: string;
  /** Target formats. Default: ['avif', 'webp'] */
  formats?: OutputFormat[] | string;
  /** Start from a named preset; explicit options override it. */
  preset?: PresetName;
  /** Responsive set. Never upscales unless enlarge is true. */
  widths?: number[] | string;
  /** Single resize width (do not combine with widths). */
  width?: number;
  /** Single resize height (do not combine with widths). */
  height?: number;
  fit?: FitMode;
  position?: string;
  /** Allow upscaling. Default: false */
  enlarge?: boolean;
  /** Prepend to output filenames. */
  prefix?: string;
  /** Append to output filenames. */
  suffix?: string;
  /** Append an 8-character content hash. Default: false */
  hash?: boolean;
  /** Flatten the output tree. Default: false */
  flat?: boolean;
  /** Delete the output directory first. Default: false */
  clean?: boolean;
  /** Copy source timestamps onto outputs. Default: false */
  preserveDates?: boolean;
  /** Include subdirectories. Default: false */
  recursive?: boolean;
  /** Only process files matching these globs. */
  include?: string | string[];
  /** Skip files matching these globs. */
  exclude?: string | string[];
  /** Follow symlinked files and directories. Default: false */
  followSymlinks?: boolean;
  /** 1-100 for all formats, or per-format values. */
  quality?: number | QualityMap;
  /** CPU effort for all applicable formats, or per-format values. */
  effort?: number | EffortMap;
  /** Lossless AVIF/WebP/PNG. Not supported for JPEG. */
  lossless?: boolean;
  /** Progressive JPEG. Default: true */
  progressive?: boolean;
  chromaSubsampling?: '4:2:0' | '4:2:2' | '4:4:4';
  /** WebP alpha quality, 1-100. Default: 100 */
  alphaQuality?: number;
  /** Force PNG palette quantization. Default: automatic by quality. */
  palette?: boolean;
  /** PNG zlib level, 0-9. Default: 9 */
  compressionLevel?: number;
  /** Search quality down until each variant fits this byte budget. */
  maxBytes?: number;
  /** Matte for transparent JPEGs. Default: '#ffffff' */
  background?: string;
  /** Keep EXIF/ICC. Default: false */
  keepMetadata?: boolean;
  /** Explicit rotation; overrides EXIF auto-orientation. */
  rotate?: number;
  /** Apply EXIF orientation. Default: true */
  autoOrient?: boolean;
  flip?: boolean;
  flop?: boolean;
  grayscale?: boolean;
  /** Gaussian blur sigma. */
  blur?: number;
  /** Sharpen sigma (true means 1). */
  sharpen?: number | boolean;
  /** Stretch contrast to the full range. */
  normalize?: boolean;
  /** Gamma correction. */
  gamma?: number;
  /** Tint while preserving luminance. */
  tint?: string;
  /** Trim uniform borders, threshold 1-100 (true means 10). */
  trim?: number | boolean;
  /** Crop as "WxH+X+Y" or an object. */
  extract?: string | ExtractOptions;
  /** Pad as n, "t,r,b,l", an array, or an object. */
  extend?: number | string | number[] | ExtendOptions;
  /** DPI for rasterizing SVG input. */
  density?: number;
  /** Add a tiny placeholder and dominant color. Default: false */
  lqip?: boolean;
  /** Reuse the output cache. API default: false; CLI default: true. */
  cache?: boolean;
  /** Cache directory. Default: node_modules/.cache/pixelpress */
  cacheDir?: string;
  /** Delete outputs that are no longer produced. Requires cache: true. */
  prune?: boolean;
  /** Re-encode even when cached. Default: false */
  force?: boolean;
  /** Stop after the first failure. Default: false */
  failFast?: boolean;
  /** Files processed in parallel. Default: 4 */
  concurrency?: number;
  /** Plan only; write nothing. Default: false */
  dryRun?: boolean;
}

export interface Variant {
  format: OutputFormat;
  /** Absolute output path. */
  path: string;
  width: number | null;
  height: number | null;
  /** Encoded size in bytes, or null in a dry run. */
  bytes: number | null;
  /** Quality actually used (lowered by maxBytes when needed). */
  quality: number;
  /** True when the output preserves animation (WebP only). */
  animated: boolean;
  /** Frame count for animated outputs, otherwise 1. */
  pages: number;
}

export interface ProcessedFile {
  /** Absolute input path. */
  input: string;
  width: number | null;
  height: number | null;
  sourceBytes: number;
  cached: boolean;
  placeholder?: string;
  dominantColor?: string;
  outputs: Variant[];
}

export interface SkippedFile {
  input: string;
  reason: string;
}

export interface FailedFile {
  input: string;
  error: string;
}

export interface Totals {
  files: number;
  outputs: number;
  cached: number;
  pruned: number;
  pruneErrors: number;
  sourceBytes: number;
  outputBytes: number | null;
  savedBytes: number | null;
  savedPercent: number | null;
  skipped: number;
  failed: number;
  durationMs: number;
}

export interface PruneError {
  path: string;
  error: string;
}

export interface ResolvedOptions {
  outDir: string;
  preset: PresetName | null;
  formats: OutputFormat[];
  widths: number[];
  quality: Required<QualityMap>;
  effort: Required<EffortMap>;
  recursive: boolean;
  flat: boolean;
  dryRun: boolean;
  cache: boolean;
  force: boolean;
  clean: boolean;
  failFast: boolean;
  followSymlinks: boolean;
  preserveDates: boolean;
  lqip: boolean;
  cacheDir: string;
  prune: boolean;
  include: string[];
  exclude: string[];
  concurrency: number;
  [key: string]: unknown;
}

export interface OptimizeResult {
  options: ResolvedOptions;
  files: ProcessedFile[];
  skipped: SkippedFile[];
  failed: FailedFile[];
  pruned: string[];
  pruneErrors: PruneError[];
  totals: Totals;
}

export interface TranscodeOptions {
  /** Default: 'webp' */
  format?: OutputFormat | 'jpg';
  width?: number;
  height?: number;
  fit?: FitMode;
  position?: string;
  quality?: number | QualityMap;
  effort?: number | EffortMap;
  lossless?: boolean;
  progressive?: boolean;
  chromaSubsampling?: '4:2:0' | '4:2:2' | '4:4:4';
  alphaQuality?: number;
  palette?: boolean;
  compressionLevel?: number;
  maxBytes?: number;
  background?: string;
  keepMetadata?: boolean;
  rotate?: number;
  autoOrient?: boolean;
  flip?: boolean;
  flop?: boolean;
  grayscale?: boolean;
  blur?: number;
  sharpen?: number | boolean;
  normalize?: boolean;
  gamma?: number;
  tint?: string;
  trim?: number | boolean;
  extract?: string | ExtractOptions;
  extend?: number | string | number[] | ExtendOptions;
  density?: number;
}

export interface TranscodeResult {
  data: Buffer;
  info: {
    format: OutputFormat;
    width: number;
    height: number;
    bytes: number;
    quality: number;
    /** True when frames were preserved (animated WebP output). */
    animated: boolean;
    /** Frame count for animated outputs, otherwise 1. */
    pages: number;
    sourceWidth: number | null;
    sourceHeight: number | null;
  };
}

export const OUTPUT_FORMATS: readonly OutputFormat[];

export function optimize(inputs: string | string[], options?: OptimizeOptions): Promise<OptimizeResult>;

export function transcode(input: Buffer | Uint8Array | string, options?: TranscodeOptions): Promise<TranscodeResult>;
