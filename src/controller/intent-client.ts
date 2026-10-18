import { INTENT_PATH, parseInterpretResponse, type InterpretRequest, type InterpretResponse } from '../shared/intent.ts';

export type IntentInterpreter = (request: InterpretRequest, signal: AbortSignal) => Promise<InterpretResponse>;

/** Only our same-origin server knows the model credentials or provider contract. */
export const interpretMusicIntent: IntentInterpreter = async (request, signal) => {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(INTENT_PATH, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin', body: JSON.stringify(request), signal: AbortSignal.any([signal, timeout]),
  });
  // Bound even an unexpected proxy/error response before parsing.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Music requests are unavailable right now.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) throw new Error('Unexpected music request response.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed = parseInterpretResponse(JSON.parse(new TextDecoder().decode(bytes)));
  if (!parsed || (!response.ok && parsed.status === 'ready')) throw new Error('Music requests are unavailable right now.');
  return parsed;
};
