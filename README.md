# Sway

An infinite instrumental stream that learns your taste. No skips, no playlists, no accounts — press play, vote 👍 or 👎, and the music keeps flowing while it adapts.

## The problem

Finding music that actually fits your taste is surprisingly hard. Recommendation engines infer what you like from skips, replays and listening history — guesses built on guesses. Playlists end, albums end, and every streaming session resets into "tell us your favorite artists." We wanted to know: **can a stream learn your taste from thumbs-up / thumbs-down alone, without ever interrupting the music?**

## The solution

Sway generates music live with **Google Lyria RealTime**. A small in-memory learner turns every vote into a weighted blend of musical features (genre, instrument, mood, texture) and steers the generation prompts toward it — cross-fading so playback never stops. Tap a word in the visualizer to lean the stream that way; like what you hear and it's saved as a moment you can return to.

- 👎 uses prepared audio when ready, with a 100 ms crossfade; otherwise it steers over ~2.5 s plus generation and playback-buffer delay
- Learns only from explicit feedback; silence never becomes evidence
- Preferences persist per-purpose in your browser (IndexedDB); optional text requests send a small preference summary to the interpreter
- The whole session is visualized live: a WebGL2 particle field that breathes with the actual audio

## Resources

| What | How we used it |
|---|---|
| **Google Lyria RealTime** | Live instrumental generation; steered by weighted prompts |
| **NVIDIA Nemotron** | Interprets submitted moods, activities and song references into a validated music brief; the team's broader agent/review work is described below. Runtime thumbs and word taps stay in the local learner |
| **Crusoe Cloud** | GPU inference serving the Nemotron agents — the LLMs stay hosted models, not a per-user download |
| **TypeScript + Vite + React** | Browser app, session controller, learner, visualizer |
| **WebSocket relay (Node)** | Keeps the API key server-side; guards the wire protocol |
| **Render** | Hosts the relay + built app (`render.yaml`, auto-deploys `main`) |

## System improvement: recursive learning

The agent doesn't just react to votes — each vote recursively updates a persistent taste model, and every later decision is made *through* that model. A like strengthens the audible blend's features; a dislike redirects using accumulated preference + uncertainty; directional likes learn from the *difference* between the rejected and approved blend; three rejections widen the search space entirely.

The loop continues after the music stops. A team of Nemotron agents reviews every session: what held listeners' votes, which steers landed and which missed. They fold those findings back into their memory, then validate candidate changes against listeners the system has never seen — so improvements generalize to the next stranger, not just the last session.

Why it produces better outcomes:

- **Faster convergence** — each session needs fewer votes to reach "yours," because the model starts where the last one ended (per-purpose profiles in IndexedDB).
- **Audible responsiveness** — a 👎 is hearable in ~2.5 s, and the honest fill indicator waits for the real generated block, so listeners learn to trust the control.
- **Graceful recovery** — probes and wide-search escapes keep the stream out of local minima instead of circling the same sound.
- **Better for every listener, not the average** — taste lives per-user, per-purpose, on-device: Focus-you and Crazy-you are separate models.
- **Improvements that generalize** — post-session reviews are tested on unseen listeners before they ship, so a change has to work for strangers, not just the person who trained it.

## Architecture

```mermaid
flowchart LR
    subgraph Browser["🎧 Browser"]
        UI["React UI<br/>(thumbs · particles)"]
        CTL["SessionController<br/>ramps · audible estimate"]
        LR["Adaptive Learner<br/>in-memory taste model"]
        PL["PCM Player<br/>AudioWorklet"]
        UI -->|"vote / nudge"| CTL
        CTL --> LR
        CTL --> PL
    end
    RELAY["🔀 Relay<br/>(auth · protocol guards)"]
    LYRIA["🎼 Google Lyria RealTime"]
    Browser <-->|"WebSocket: steer ⇄ PCM audio"| RELAY
    RELAY <-->|"secure stream"| LYRIA
```

While listening, two bounded streams prepare the next Like and Dislike choices. Vote → learner picks a target → matching prepared audio replaces playback with a 100 ms crossfade → the chosen stream resumes and the next pair is prepared. Unready, stale or failed candidates use the normal prompt-steering ramp.

Preparation uses extra generation and up to three provider sessions; `createBrowserController({ lookahead: false })` disables it. See [cache integration and measured latency](docs/adaptive-integration.md#main-integration-and-live-cache-verification--2026-10-17) for readiness conditions and test limits.

## Optional music requests

Describe a mood, an activity or a song before pressing Start, or open the quiet request control while listening. Apply shows a compact interpretation; Edit and Clear keep it easy to change. Details expose constraints and song sources without covering the player. The current visualizer, style ring, moments and prepared feedback audio remain available.

Set `CRUSOE_API_KEY` on the server to enable interpretation. A submission makes a bounded Nemotron call, with a Wikipedia lookup when needed for named references. The validated brief guides the existing learner; it creates no preference evidence and never silently switches the selected profile. Applying a new brief rebuilds cached choices; failed requests keep current music playing. [Contract, privacy and limits](docs/text-music-intent.md).

## Run

```sh
pnpm install --frozen-lockfile
cp .env.example .env     # GEMINI_API_KEY for live mode; or ?mock / MUSIC_MODE=mock
pnpm dev                 # vite + relay at :5173
pnpm test                # 430+ unit + e2e tests
pnpm typecheck && pnpm build
```

Live: [sway-relay.onrender.com](https://sway-relay.onrender.com) · Deploy notes: [docs/deploy-render.md](docs/deploy-render.md) · Deep dives: [docs/](docs/)

## Design rules we kept

- Learning uses **explicit thumbs feedback only**. Word taps and text requests steer without adding evidence; skips, dwell, and silence are never inferred as votes.
- **The music never stops.** Every steer is a cross-fade; votes while connecting or reconnecting steer with zero learning weight.
- **Taste memory stays in the browser.** Optional text interpretation sends the submitted text, current brief/features and a small likes/dislikes summary to Crusoe. Reference queries go to Wikipedia; rendered prompts go to Lyria. The full feedback history is not sent.
