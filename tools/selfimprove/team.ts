// Shared helpers: bundle I/O, hashing, CLI flags, and the live wiring (gateway + advisor policy) used by loop and final.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bundle } from './advisor.ts';
import { createAdvisorPolicy } from './advisor.ts';
import { CrusoeClient, loadCrusoeConfig, type CrusoeConfig } from './crusoe.ts';
import { DEFAULT_CACHE_DIR, LlmGateway, sha } from './llm.ts';
import { sanitizeParams } from './params.ts';

export const ARTIFACTS_DIR = new URL('./artifacts/', import.meta.url).pathname;
export const RUNS_DIR = new URL('./runs/', import.meta.url).pathname;
export const RESULTS_DIR = new URL('./results/', import.meta.url).pathname;

export function readBundle(dir: string): Bundle {
  return {
    advisorPrompt: readFileSync(join(dir, 'advisor_prompt.md'), 'utf8'),
    playbook: readFileSync(join(dir, 'playbook.md'), 'utf8'),
    params: sanitizeParams(JSON.parse(readFileSync(join(dir, 'params.json'), 'utf8'))).params,
  };
}

export function writeBundle(dir: string, b: Bundle): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'advisor_prompt.md'), b.advisorPrompt);
  writeFileSync(join(dir, 'playbook.md'), b.playbook);
  writeFileSync(join(dir, 'params.json'), JSON.stringify(b.params, null, 2) + '\n');
}

export const bundleHash = (b: Bundle) => sha(JSON.stringify([b.advisorPrompt.trim(), b.playbook.trim(), b.params]));

export function flag(args: string[], name: string, env?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return env ? process.env[env] : undefined;
}
export const numFlag = (args: string[], name: string, env: string, dflt: number) => {
  const v = flag(args, name, env);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
};

export type Live = { cfg: CrusoeConfig; gateway: LlmGateway; advisor: (b: Bundle, name: string) => ReturnType<typeof createAdvisorPolicy> };

export function createLive(opts: { noCache?: boolean; advisorMaxTokens?: number }): Live {
  const cfg = loadCrusoeConfig();
  const gateway = new LlmGateway(new CrusoeClient(cfg), opts.noCache ? null : DEFAULT_CACHE_DIR);
  return {
    cfg,
    gateway,
    advisor: (bundle, name) => createAdvisorPolicy({ gateway, model: cfg.fastModel, bundle, name, maxTokens: opts.advisorMaxTokens ?? 2000 }),
  };
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const pts = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
