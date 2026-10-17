// LLM gateway: on-disk response cache (reruns are free and deterministic), per-role call/token accounting, timeouts.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, ChatResult } from './crusoe.ts';
import { extractJson } from './crusoe.ts';

export type ChatClient = {
  chat(args: { model: string; messages: ChatMessage[]; temperature?: number; maxTokens?: number; thinking?: boolean }): Promise<ChatResult>;
};

export type Role = 'advisor' | 'reviewer' | 'rewriter';
export type RoleStats = { calls: number; cacheHits: number; errors: number; promptTokens: number; completionTokens: number; latencyMs: number };
export const emptyStats = (): RoleStats => ({ calls: 0, cacheHits: 0, errors: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 });

export type GatewayRequest = {
  role: Role;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  thinking?: boolean;
  timeoutMs?: number;
};

export const DEFAULT_CACHE_DIR = new URL('./.cache/', import.meta.url).pathname;

// Key = hash(model, messages, temperature, thinking). max_tokens is excluded so raising it does not invalidate good answers.
export function cacheKey(req: Pick<GatewayRequest, 'model' | 'messages' | 'temperature' | 'thinking'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ model: req.model, messages: req.messages, temperature: req.temperature, thinking: req.thinking ?? true }))
    .digest('hex');
}

export class LlmGateway {
  readonly stats: Record<Role, RoleStats> = { advisor: emptyStats(), reviewer: emptyStats(), rewriter: emptyStats() };
  private readonly inflight = new Map<string, Promise<ChatResult>>();

  constructor(private readonly client: ChatClient, private readonly cacheDir: string | null = DEFAULT_CACHE_DIR) {
    if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  }

  async chat(req: GatewayRequest): Promise<ChatResult & { cached: boolean }> {
    const s = this.stats[req.role];
    const key = cacheKey(req);
    const file = this.cacheDir ? join(this.cacheDir, `${key}.json`) : null;
    if (file && existsSync(file)) {
      try {
        const hit = JSON.parse(readFileSync(file, 'utf8')) as ChatResult;
        s.cacheHits++;
        return { ...hit, cached: true };
      } catch { /* corrupt entry: refetch */ }
    }
    // Identical concurrent requests share one call so paired runs stay identical even on a cold cache.
    let p = this.inflight.get(key);
    const shared = Boolean(p);
    if (!p) {
      p = withTimeout(
        this.client.chat({ model: req.model, messages: req.messages, temperature: req.temperature, maxTokens: req.maxTokens, thinking: req.thinking }),
        req.timeoutMs,
      );
      this.inflight.set(key, p);
      p.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    try {
      const r = await p;
      if (shared) {
        s.cacheHits++;
      } else {
        s.calls++;
        s.promptTokens += r.promptTokens ?? 0;
        s.completionTokens += r.completionTokens ?? 0;
        s.latencyMs += r.latencyMs;
        // Only non-empty answers are cached; an empty reply (e.g. token budget spent reasoning) is retried next time.
        if (file && r.text.trim()) writeFileSync(file, JSON.stringify({ text: r.text, promptTokens: r.promptTokens, completionTokens: r.completionTokens, latencyMs: r.latencyMs }));
      }
      return { ...r, cached: false };
    } catch (e) {
      if (!shared) s.errors++;
      throw e;
    }
  }

  snapshot(): Record<Role, RoleStats> {
    return JSON.parse(JSON.stringify(this.stats));
  }
}

export function diffStats(after: Record<Role, RoleStats>, before: Record<Role, RoleStats>): Record<Role, RoleStats> {
  const out = {} as Record<Role, RoleStats>;
  for (const role of Object.keys(after) as Role[]) {
    const a = after[role];
    const b = before[role];
    out[role] = {
      calls: a.calls - b.calls,
      cacheHits: a.cacheHits - b.cacheHits,
      errors: a.errors - b.errors,
      promptTokens: a.promptTokens - b.promptTokens,
      completionTokens: a.completionTokens - b.completionTokens,
      latencyMs: a.latencyMs - b.latencyMs,
    };
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
  if (!ms) return p;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`LLM call timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Strict-ish JSON from model text: whole text, then a fenced block, then the first balanced object.
export function parseModelJson(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    try { return JSON.parse(fence[1]!.trim()); } catch { /* fall through */ }
  }
  return extractJson(t);
}

export const sha = (s: string, n = 12) => createHash('sha256').update(s).digest('hex').slice(0, n);
