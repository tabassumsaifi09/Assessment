#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseCases, runBatch } from './batchRunner';
import { logger } from '../util/logger';

/**
 * Batch entry point (Section 9 of the brief):
 *
 *   npm run evaluate -- --input <cases.json> --output <kits.json>
 *
 * It runs the same pipeline the web application runs. Private and loopback
 * addresses are permitted here by default because evaluation company sites may
 * be served locally; pass --no-private to enforce the production URL guard.
 */
interface CliArgs {
  input: string;
  output: string;
  concurrency: number;
  allowPrivateNetwork: boolean;
  perCaseTimeoutMs: number;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }

  const input = typeof args.input === 'string' ? args.input : '';
  const output = typeof args.output === 'string' ? args.output : '';
  if (!input || !output) {
    throw new Error('usage: npm run evaluate -- --input <cases.json> --output <kits.json>');
  }
  return {
    input,
    output,
    concurrency: Number(args.concurrency ?? 2) || 2,
    allowPrivateNetwork: args['no-private'] !== true,
    perCaseTimeoutMs: Number(args['case-timeout-ms'] ?? 150_000) || 150_000,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(process.cwd(), args.input);
  const outputPath = resolve(process.cwd(), args.output);

  const raw = await readFile(inputPath, 'utf8');
  let cases;
  try {
    cases = parseCases(JSON.parse(raw));
  } catch (error) {
    throw new Error(`could not read cases from ${inputPath}: ${(error as Error).message}`);
  }

  logger.info(`running ${cases.length} case(s) with concurrency ${args.concurrency}`);
  const startedAt = Date.now();

  const output = await runBatch(cases, {
    concurrency: args.concurrency,
    allowPrivateNetwork: args.allowPrivateNetwork,
    perCaseTimeoutMs: args.perCaseTimeoutMs,
    onCaseDone: (entry, index, total) => {
      const suffix = entry.status === 'ok' ? '' : ` (${entry.error?.code})`;
      logger.info(`[${index + 1}/${total}] ${entry.id}: ${entry.status}${suffix}`);
    },
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  const ok = output.kits.filter((entry) => entry.status === 'ok').length;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info(`wrote ${outputPath}: ${ok}/${output.kits.length} ok in ${seconds}s`);
}

main().catch((error: unknown) => {
  logger.error((error as Error).message);
  process.exitCode = 1;
});
