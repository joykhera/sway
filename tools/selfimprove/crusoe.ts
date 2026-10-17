// Minimal OpenAI-compatible client for Crusoe Managed Inference. Server/script side only: never bundle for the browser.

export type CrusoeConfig = {
  apiKey: string;
  baseUrl: string;
  fastModel: string; // many cheap calls (advisor, simulated listeners)
  strongModel: string; // few expensive calls (reviewer, rewriter)
};

export function loadCrusoeConfig(env: NodeJS.ProcessEnv = process.env): CrusoeConfig {
  const apiKey = env.CRUSOE_API_KEY?.trim();
  if (!apiKey) throw new Error('CRUSOE_API_KEY is required (put it in .env, which is gitignored)');
  return {
    apiKey,
    baseUrl: (env.CRUSOE_BASE_URL?.trim() || 'https://api.inference.crusoecloud.com/v1').replace(/\/+$/, ''),
    fastModel: env.CRUSOE_MODEL_FAST?.trim() || 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
    strongModel: env.CRUSOE_MODEL_STRONG?.trim() || 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  };
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type ChatResult = { text: string; promptTokens?: number; completionTokens?: number; latencyMs: number };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ClientOptions = {
  fetch?: FetchLike;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class CrusoeClient {
  private readonly fetch: FetchLike;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly cfg: CrusoeConfig, opts: ClientOptions = {}) {
    this.fetch = opts.fetch ?? ((u, i) => fetch(u, i));
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async listModels(): Promise<string[]> {
    const body = (await this.request('/models', { method: 'GET' })) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  }

  async chat(args: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    // Nemotron reasons before answering by default. false disables it (much faster, fewer tokens) via the chat template.
    thinking?: boolean;
  }): Promise<ChatResult> {
    const started = Date.now();
    const body = (await this.request('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        temperature: args.temperature ?? 0.7,
        max_tokens: args.maxTokens ?? 1024,
        ...(args.thinking === false ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
    })) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      promptTokens: body.usage?.prompt_tokens,
      completionTokens: body.usage?.completion_tokens,
      latencyMs: Date.now() - started,
    };
  }

  // 429 and 5xx retry with exponential backoff (Crusoe documents 429s; default limits are unpublished).
  private async request(path: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(`${this.cfg.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      });
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`Crusoe ${path} failed: HTTP ${res.status} ${text}`); // never include headers or the key
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.baseDelayMs * 2 ** attempt);
    }
  }
}

// Models often wrap JSON in prose or code fences; take the first balanced object.
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object in model output');
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in model output');
}
