/** Minimal argv parsing for scripts/smoke-lyria.ts. */

export type RateOption = 48000 | 44100 | 'none';

export interface SmokeArgs {
  durationSec: number;
  rate: RateOption;
  parallel: number;
  outDir: string | undefined;
  help: boolean;
}

export const USAGE = `Usage: pnpm smoke [-- options]

Options:
  --duration <sec>          Run length in seconds (default 720 = 12 min, past the ~10-min cap)
  --rate <48000|44100|none> sampleRateHz sent in the config (default 48000; "none" omits it)
  --parallel <n>            n > 1: concurrency probe — open n sessions at once for ~20 s (no WAV)
  --out <dir>               Output directory (default smoke-out/<timestamp>)
  --help                    Show this help

Requires GEMINI_API_KEY (in .env or the environment).`;

export type ParseResult = { ok: true; args: SmokeArgs } | { ok: false; error: string };

export function parseArgs(argv: ReadonlyArray<string>): ParseResult {
  const args: SmokeArgs = { durationSec: 720, rate: 48000, parallel: 1, outDir: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? '';
    if (raw === '--') continue; // pnpm may forward a bare separator
    if (raw === '--help' || raw === '-h') {
      args.help = true;
      continue;
    }
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    let value: string | undefined;
    if (raw.startsWith('--') && eq > 0) {
      value = raw.slice(eq + 1);
    } else {
      value = argv[i + 1];
      i++;
    }
    if (!['--duration', '--rate', '--parallel', '--out'].includes(flag)) {
      return { ok: false, error: `Unknown argument: ${raw}` };
    }
    if (value === undefined || value === '') {
      return { ok: false, error: `Missing value for ${flag}` };
    }
    switch (flag) {
      case '--duration': {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `--duration must be a positive number, got "${value}"` };
        args.durationSec = n;
        break;
      }
      case '--rate': {
        if (value === 'none') args.rate = 'none';
        else if (value === '48000') args.rate = 48000;
        else if (value === '44100') args.rate = 44100;
        else return { ok: false, error: `--rate must be 48000, 44100 or none, got "${value}"` };
        break;
      }
      case '--parallel': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 50) return { ok: false, error: `--parallel must be an integer 1..50, got "${value}"` };
        args.parallel = n;
        break;
      }
      case '--out':
        args.outDir = value;
        break;
    }
  }
  return { ok: true, args };
}
