// Reviewer (strong model): reads compact TRAIN transcripts and diagnoses what worked and what failed.
// Transcripts are built only from the policy's own step log and the episode score: no persona weights, pairs,
// pickiness, fatigue or noise ever reach this text.
import type { Bundle, Step } from './advisor.ts';
import type { LlmGateway } from './llm.ts';
import type { EpisodeResult } from './simulator.ts';

export type TranscriptEpisode = { label: string; score: number; steps: Step[] };

export function toTranscriptEpisodes(results: EpisodeResult[]): TranscriptEpisode[] {
  return results.map((r) => ({ label: `listener${r.personaIndex + 1}.rep${r.rep + 1}`, score: r.episode.score, steps: (r.episode.trace ?? []) as Step[] }));
}

export function summarize(eps: TranscriptEpisode[]) {
  let llmUp = 0, llmN = 0, lrnUp = 0, lrnN = 0, calls = 0, failed = 0, repeatsAfterUp = 0, downAfterRepeat = 0;
  for (const e of eps) {
    e.steps.forEach((s, i) => {
      if (s.src === 'llm') { llmN++; if (s.vote === 'up') llmUp++; } else { lrnN++; if (s.vote === 'up') lrnUp++; }
      if (s.call) { calls++; if (s.call !== 'ok' || !s.valid) failed++; }
      const prev = e.steps[i - 1];
      if (prev && prev.vote === 'up' && prev.ids.join() === s.ids.join()) { repeatsAfterUp++; if (s.vote === 'down') downAfterRepeat++; }
    });
  }
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');
  return {
    episodes: eps.length,
    meanScore: eps.reduce((a, e) => a + e.score, 0) / (eps.length || 1),
    text: [
      `episodes: ${eps.length}; mean score (share of likes after 5 warmup votes): ${(100 * eps.reduce((a, e) => a + e.score, 0) / (eps.length || 1)).toFixed(1)}%`,
      `targets chosen by advisor candidates: ${llmN} (liked ${pct(llmUp, llmN)}); chosen by learner: ${lrnN} (liked ${pct(lrnUp, lrnN)})`,
      `advisor calls: ${calls}; calls that produced no valid candidate: ${failed}`,
      `same combination replayed right after a like: ${repeatsAfterUp} times, disliked on replay ${pct(downAfterRepeat, repeatsAfterUp)}`,
    ].join('\n'),
  };
}

const short = (ids: string[]) => ids.join('+');

export function formatTranscripts(eps: TranscriptEpisode[]): string {
  const body = eps.map((e) => {
    const steps = e.steps.map((s) => `${s.t}:${short(s.ids)}[${s.src === 'llm' ? 'A' : 'L'}]${s.vote === 'up' ? '+' : '-'}${s.call ? `{call:${s.call},${s.valid ?? 0}}` : ''}`).join(' ');
    return `## ${e.label} score=${(e.score * 100).toFixed(0)}%\n${steps}`;
  });
  return [
    'Legend: t:features[A=advisor candidate chosen | L=learner target]+ liked / - disliked; {call:ok,n} = advisor consulted after this vote, n valid candidates.',
    summarize(eps).text,
    '',
    ...body,
  ].join('\n');
}

export async function review(args: { gateway: LlmGateway; model: string; bundle: Bundle; transcripts: string; maxTokens?: number }): Promise<string> {
  const { bundle } = args;
  const messages = [
    {
      role: 'system' as const,
      content:
        'You are the Reviewer on a self-improving music recommendation team. A deterministic learner plus an LLM advisor choose musical feature combinations for simulated listeners who vote thumbs up/down. ' +
        'The advisor proposes candidates; a deterministic chooser picks between them and the learner using learner scores plus bonuses. ' +
        'Listeners have hidden tastes that may include liking a feature only in combination with another, different strictness, ' +
        'and getting bored when the same sound repeats. You only see what the team saw: votes and chosen combinations. Be concrete and evidence-based.',
    },
    {
      role: 'user' as const,
      content: [
        '# Current advisor prompt', bundle.advisorPrompt, '',
        '# Current playbook', bundle.playbook, '',
        '# Current params', JSON.stringify(bundle.params), '',
        '# Train transcripts', args.transcripts, '',
        'Write a diagnosis (max ~350 words): 1) what worked, 2) what failed (with transcript evidence), 3) the 3 most promising specific changes to the prompt, playbook or params. Plain text.',
      ].join('\n'),
    },
  ];
  try {
    const r = await args.gateway.chat({ role: 'reviewer', model: args.model, messages, temperature: 0.3, maxTokens: args.maxTokens ?? 6000, timeoutMs: 300_000 });
    return r.text.trim().slice(0, 6000) || '(reviewer returned an empty diagnosis)';
  } catch (e) {
    return `(reviewer failed: ${String(e).slice(0, 200)})`;
  }
}
