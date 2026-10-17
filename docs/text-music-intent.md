# Text requests and learned music preferences

Sway accepts a style, activity or song reference before Start and during listening. Apply interprets the text without starting audio. The selected purpose stays unchanged. Clear removes the request and reselects using that purpose's learned taste.

## Flow

1. The browser sends at most 1,200 characters, the selected purpose, current features, current brief and a small summary of learned likes/dislikes to same-origin `POST /api/intent`.
2. The server calls Crusoe's `nvidia/Nemotron-3.5-Lightning-30B-A3B` with thinking disabled and a strict JSON schema. It validates the complete output again. An invalid response gets at most one repair, inside a shared 25-second deadline.
3. Named references can request one bounded Wikipedia lookup: search and introductory extracts for at most three pages, with a six-second deadline and ten-minute bounded cache. Only retrieved source IDs can become links. Missing or ambiguous evidence asks for clarification. This does not listen to, reproduce or measure the reference audio.
4. The validated brief carries explicit required/excluded features, softer feature hints, a short supplemental sonic description and optional exclusions outside the feature vocabulary. Impossible recipe constraints are rejected. The UI shows the interpretation, enforced constraints and available sources.
5. The app filters its 375 musical recipes by explicit constraints, then ranks allowed choices with learned preference, uncertainty, purpose, bounded intent hints and transition cost. Hints weaken with effective evidence. Explicit constraints survive likes, dislikes, broad-search escape and automatic freshness until changed or cleared.

The existing 18-feature model learns combinations, not arbitrary words, tempo, artists or new genres. Supplemental descriptions remain generation instructions. The model's translation and the generator's audio can still miss the listener's intent; the displayed interpretation is editable. Source membership and lexical checks reduce errors but do not prove every musical claim.

## State and playback

Applying or clearing text changes the target without changing the learner's matrix, reward vector or vote count. Applying uses the latest state so thumbs received during interpretation are retained. Raw feedback includes the active brief and whether that brief was estimated to be audible. Old buffered audio during a text transition has zero evidence weight for the new request. Reconnects retain the prior heard context until the estimated new timeline clears the queue.

Successful requests invalidate both prepared feedback branches. New predictions, actual thumbs and freshness all receive the same active brief. Failures retain the previous brief, music and candidates. New requests, Clear, Stop, reset and purpose switches cancel stale work. Audio attribution remains an estimate based on the player queue and configured generation delay, not an audio-content classifier.

Ordinary changes use the existing prompt ramp. If blending two valid endpoints would exceed the relay's ten-prompt limit, the controller sends the complete new endpoint immediately; it does not discard constraints to fit. Existing queued audio and provider latency still apply. Ready prepared branches retain their 100 ms crossfade.

Each browser-local purpose profile stores its last applied brief and original text alongside its existing learner state. It is restored on the next visit; Clear removes only that brief, and reset clears all local profiles and feedback. There is no cross-device synchronization or universal taste model. No text submission is logged as a fake vote. Feedback export includes context; no server database is introduced.

## Configuration

Set `CRUSOE_API_KEY` only in the server environment. No browser variable or OpenAI SDK is required. The endpoint and model are fixed in `server/intent/service.ts`. Missing credentials, account/billing errors, invalid output and timeouts produce a friendly error while normal profiles and thumbs remain usable.

The route accepts same-origin JSON POSTs, up to 16 KiB, with two concurrent interpretations and twelve requests per minute for the whole server. Client disconnects abort work. Provider response bodies are bounded; raw errors, keys and prompts are not written to logs. These guards are not user authentication: host the app behind the intended access boundary. Vite proxies `/api/intent` preserving Host; the machine-local preview retains its Tailscale interface and exact authority/origin gate.

Unit and integration tests cover schema/feasibility, bounded lookup, provider failures/repair/cancellation, HTTP guards, learner invariants, saved briefs, stale responses, buffered feedback, speculative invalidation and UI behavior. Live provider compatibility and browser checks are recorded in the PR validation notes; automated mocks alone do not demonstrate musical quality or preference improvement.
