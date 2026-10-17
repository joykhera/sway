# Deploying sway to Render

One Docker web service: serves the built SPA from `dist/` and relays `/api/music`
WebSocket traffic to Lyria RealTime. Render terminates TLS and injects `PORT`
(the server reads it; `HOST` must be `0.0.0.0` — already set via env).

## 1. Prereqs

- Repo pushed to GitHub/GitLab; `render.yaml` and `Dockerfile` on `main`
  (`feat/lyria-relay` work merged).
- A Render account.
- A `GEMINI_API_KEY` from https://aistudio.google.com/apikey — paste it **only**
  into Render's env-var UI. Never into git, the Dockerfile, tickets, or chat.

## 2. Path A — Blueprint (uses `render.yaml`)

1. Dashboard → **New** → **Blueprint**.
2. Connect the repo. Render reads `render.yaml` and creates the `sway-relay` service.
3. When prompted for `GEMINI_API_KEY` (`sync: false`), paste your key.
4. Deploy. Render builds the image and polls `GET /healthz` until it returns 200.

## 3. Path B — Manual web service

1. **New** → **Web Service** → connect the repo.
2. Runtime: **Docker** (Render picks up `./Dockerfile` automatically).
3. Health Check Path: `/healthz`.
4. Environment variables — exactly these:

   | Key | Value |
   |---|---|
   | `MUSIC_MODE` | `live` |
   | `HOST` | `0.0.0.0` |
   | `NODE_ENV` | `production` |
   | `GEMINI_API_KEY` | your key (mark as secret) |

   Do **not** set `PORT` — Render injects it (usually `10000`).
5. Plan: **Free** is fine for MVP. Deploy.

## 4. Verify

```sh
curl https://<your-service>.onrender.com/healthz
# → 200 {"ok":true}
```

Open `https://<your-service>.onrender.com` → **Start**. In live mode real Lyria
audio arrives after ~5–10 s of settling. With `MUSIC_MODE=mock` you get a paced
test tone and zero Google calls (no key needed).

## 5. Caveats

| Caveat | Detail |
|---|---|
| Free-tier sleep | Service sleeps on inactivity; first request after sleep cold-starts (image boot + reconnect). Expect the first `/healthz` to be slow. |
| WebSocket lifetime | Render supports long-lived WS upgrades on Docker services. Upstream Lyria sessions cap ~10 min — the relay drops + reconnects upstream transparently; the browser socket stays open. |
| TLS | Automatic on `*.onrender.com`. A secure context is required by the client's AudioWorklet — this is why the hosted path works where plain `http://` wouldn't. |
| Quota | Per-Google-project and unpublished for `lyria-realtime-exp`; tighter for experimental models. Watch https://aistudio.google.com/rate-limit. |
| Key hygiene | `GEMINI_API_KEY` is server-side only (R8): never shipped in the client bundle, and the relay must never log upstream URLs — the SDK puts the key in `?key=`. |

## 6. Scaling

The relay caps concurrent upstream streams at **5** (enforced server-side). One
free Render instance ≈ the MVP's 1–5 testers. Scaling beyond that means a paid
plan and/or more instances — not needed now.

## 7. Rollback

- Dashboard → service → **Deploys** → redeploy a previous successful image.
- To stop auto-deploying on every push to `main`: set `autoDeploy: false` in
  `render.yaml` (Blueprint) or toggle **Auto-Deploy** off in the dashboard
  (manual service).
