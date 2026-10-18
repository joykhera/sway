import { randomUUID } from 'node:crypto';
import type { FeatureId } from '../../src/shared/intent.ts';
import { log } from '../log.ts';

export type IntentReason = 'accepted' | 'model_clarify' | 'model_unsupported' | 'missing_key'
  | 'provider_account' | 'provider_rate_limit' | 'provider_unavailable' | 'lookup_failed' | 'lookup_empty'
  | 'song_title_missing' | 'missing_title_reference' | 'repeated_lookup' | 'missing_reference'
  | 'lookup_required' | 'constraints_conflict' | 'invalid_plan' | 'request_failed' | 'timeout' | 'aborted';
export type IntentHttpReason = 'interpreted' | 'method' | 'origin' | 'content_type' | 'unavailable'
  | 'body_too_large' | 'rate_limit' | 'concurrency_limit' | 'invalid_request' | 'invalid_json'
  | 'body_timeout' | 'internal_error' | 'aborted' | 'shutdown';
type Timed = { requestId: string; durationMs: number };
export type IntentEvent = Timed & (
  | { event: 'started' }
  | { event: 'completion'; callCount: number; httpStatus: number | null; outcome: 'response' | 'failed' | 'aborted' }
  | { event: 'lookup'; sourceCount: number; outcome: 'ready' | 'empty' | 'failed' | 'aborted' }
  | { event: 'repair'; callCount: number; reason: 'invalid_plan' | 'missing_title_reference' }
  | { event: 'finished'; status: 'ready' | 'clarify' | 'unsupported' | 'error' | 'abort'; reason: IntentReason;
      callCount: number; sourceCount: number; featureHints?: FeatureId[]; requiredFeatures?: FeatureId[];
      excludedFeatures?: FeatureId[]; contextLength?: number }
  | { event: 'http'; httpStatus: number | null; reason: IntentHttpReason }
);
export type IntentObserver = (event: IntentEvent) => void | Promise<void>;
export type IntentRequestContext = { requestId: string };
export const requestId = (context?: IntentRequestContext): string =>
  context && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.requestId)
    ? context.requestId : randomUUID();
export const durationMs = (started: number): number => Math.max(0, Math.round(performance.now() - started));

/** Only fixed metadata enters this sink. Never log exception messages or request/model text. */
export function observe(observer: IntentObserver | undefined, event: IntentEvent): void {
  try {
    const pending = observer ? observer(event) : log.info('intent', event.event, event);
    if (pending) void Promise.resolve(pending).catch(() => {});
  } catch { /* Diagnostics must not affect request behavior. */ }
}
