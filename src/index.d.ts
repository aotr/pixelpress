export type OutputFormat = 'avif' | 'webp' | 'jpeg' | 'png';

export interface QualityMap {
  avif?: number;
  webp?: number;
  jpeg?: number;
  png?: number;
}

export interface OptimizeOptions {
  /** Directory for encoded files. Default: pixelpress-out */
  outDir?: string;
  /** Target formats. Default: ['avif', 'webp'] */
  formats?: OutputFormat[] | string;
  /** 1-100 for all formats, or per-format values. */
  quality?: number | QualityMap;
  /** Responsive widths in pixels. Never upscales. */
  widths?: number[] | string;
  /** Include subdirectories. Default: false */
  recursive?: boolean;
  /** Flatten the output tree. Default: false */
  flat?: boolean;
  /** Plan only; write nothing. Default: false */
  dryRun?: boolean;
  /** Keep EXIF/ICC. Default: false */
  keepMetadata?: boolean;
  /** Matte for transparent JPEGs. Default: '#ffffff' */
  background?: string;
  /** Files processed in parallel. Default: 4 */
  concurrency?: number;
}

export interface Variant {
  format: OutputFormat;
  /** Absolute output path. */
  path: string;
  width: number | null;
  height: number | null;
  /** Encoded size in bytes, or null in dry runs. */
  bytes: number | null;
}

export interface ProcessedFile {
  /** Absolute input path. */
  input: string;
  width: number | null;
  height: number | null;
  sourceBytes: number;
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
  sourceBytes: number;
  outputBytes: number | null;
  savedBytes: number | null;
  savedPercent: number | null;
  skipped: number;
  failed: number;
  durationMs: number;
}

export interface OptimizeResult {
  options: Required<Pick<OptimizeOptions, 'outDir' | 'formats' | 'widths' | 'recursive' | 'flat' | 'dryRun' | 'keepMetadata' | 'background' | 'concurrency'>> & {
    quality: Required<QualityMap>;
  };
  files: ProcessedFile[];
  skipped: SkippedFile[];
  failed: FailedFile[];
  totals: Totals;
}

export interface TranscodeOptions {
  /** Default: 'webp' */
  format?: OutputFormat;
  width?: number;
  /** 1-100, or per-format values. */
  quality?: number | QualityMap;
  background?: string;
  keepMetadata?: boolean;
}

export interface TranscodeResult {
  data: Buffer;
  info: {
    format: OutputFormat;
    width: number;
    height: number;
    bytes: number;
    sourceWidth: number | null;
  };
}

export const OUTPUT_FORMATS: readonly OutputFormat[];

export function optimize(inputs: string | string[], options?: OptimizeOptions): Promise<OptimizeResult>;

export function transcode(input: Buffer | Uint8Array | string, options?: TranscodeOptions): Promise<TranscodeResult>;
