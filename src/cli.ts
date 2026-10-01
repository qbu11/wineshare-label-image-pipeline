#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalizeImage, extensionForContentType, ImageCanonicalizationError } from './canonicalize.js';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_PIXELS, SANITIZER_VERSION } from './constants.js';

interface CliOptions {
  inputs: string[];
  outDir: string;
  suffix: string;
  manifestPath: string;
  continueOnError: boolean;
  maxBytes: number;
  maxPixels: number;
}

interface ManifestEntry {
  input: string;
  output?: string;
  contentType?: string;
  inputBytes?: number;
  outputBytes?: number;
  sha256?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  error?: string;
  errorCode?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputs: [],
    outDir: '',
    suffix: '.canonical',
    manifestPath: '',
    continueOnError: false,
    maxBytes: DEFAULT_MAX_BYTES,
    maxPixels: DEFAULT_MAX_PIXELS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => {
      index += 1;
      if (index >= argv.length) usage(`Missing value for ${arg}`);
      return argv[index]!;
    };
    if (arg === '--out-dir') options.outDir = next();
    else if (arg === '--suffix') options.suffix = next();
    else if (arg === '--json') options.manifestPath = next();
    else if (arg === '--max-bytes') options.maxBytes = Number(next());
    else if (arg === '--max-pixels') options.maxPixels = Number(next());
    else if (arg === '--continue-on-error') options.continueOnError = true;
    else if (arg === '--help' || arg === '-h') usage();
    else if (arg.startsWith('--')) usage(`Unknown option: ${arg}`);
    else options.inputs.push(arg);
  }
  if (!options.inputs.length) usage('Provide at least one input image.');
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) usage('--max-bytes must be a positive integer.');
  if (!Number.isSafeInteger(options.maxPixels) || options.maxPixels <= 0) usage('--max-pixels must be a positive integer.');
  return options;
}

function usage(error?: string): never {
  const lines = [
    'wineshare-canonicalize — reproduce the WineShare mini-program recognition image pipeline',
    '',
    'Usage:',
    '  wineshare-canonicalize <file...> [--out-dir <dir>] [--suffix <s>] [--json <manifest>]',
    '                         [--max-bytes N] [--max-pixels N] [--continue-on-error]',
    '',
    'Defaults: suffix ".canonical", limits 8 MiB / 24 MP (server hard caps;',
    'the mini-program client enforces 6 MiB before upload).',
  ];
  if (error) {
    console.error(`error: ${error}`);
    console.error(lines.join('\n'));
    process.exit(2);
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const entries: ManifestEntry[] = [];

  for (const input of options.inputs) {
    const startedAt = Date.now();
    const raw = await readFile(input);
    try {
      const canonical = await canonicalizeImage(raw, {
        maxBytes: options.maxBytes,
        maxPixels: options.maxPixels,
      });
      const parsed = path.parse(input);
      const outputDir = options.outDir || parsed.dir || '.';
      await mkdir(outputDir, { recursive: true });
      const output = path.join(outputDir, `${parsed.name}${options.suffix}.${extensionForContentType(canonical.contentType)}`);
      await writeFile(output, canonical.bytes);
      entries.push({
        input,
        output,
        contentType: canonical.contentType,
        inputBytes: raw.byteLength,
        outputBytes: canonical.sizeBytes,
        sha256: canonical.sha256,
        width: canonical.width,
        height: canonical.height,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const entry: ManifestEntry = {
        input,
        inputBytes: raw.byteLength,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
      if (error instanceof ImageCanonicalizationError) entry.errorCode = error.code;
      entries.push(entry);
      if (!options.continueOnError) {
        console.error(JSON.stringify(entry, null, 2));
        if (options.manifestPath) await writeManifest(options.manifestPath, options, entries);
        return 1;
      }
    }
  }

  for (const entry of entries) {
    if (entry.error) {
      console.error(`FAIL ${entry.input}: ${entry.error}`);
    } else {
      console.log(`OK   ${entry.input} -> ${entry.output} (${entry.width}x${entry.height}, ${entry.outputBytes} bytes, sha256 ${entry.sha256})`);
    }
  }
  if (options.manifestPath) {
    await writeManifest(options.manifestPath, options, entries);
  }
  return entries.some((entry) => entry.error) ? 1 : 0;
}

async function writeManifest(manifestPath: string, options: CliOptions, entries: ManifestEntry[]): Promise<void> {
  const manifest = {
    sanitizerVersion: SANITIZER_VERSION,
    limits: { maxBytes: options.maxBytes, maxPixels: options.maxPixels },
    entries,
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
