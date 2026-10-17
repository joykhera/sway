**What worked**  
- The advisor’s proposals were liked more often than the learner’s (42 % vs 33 %), showing that the LLM can surface useful feature combos when it manages to output valid candidates.  
- In several transcripts the advisor hit a “sweet spot” after a few iterations and kept the listener engaged for a stretch (e.g., listener 4’s long run of `electronic+strings+dreamy+layered` with 13 consecutive likes).  
- The playbook rule “don’t reuse a liked combo unchanged” was followed in a few cases (listener 2’s switch from `classical+guitar+dreamy+rhythmic` to `ambient+guitar+dreamy+sparse` after a like).

**What failed**  
- **Repeated liked combos → rapid boredom**: the log shows 72 immediate replays of a liked combination; 58 % of those replays were disliked (e.g., listener 1: `ambient+synth+energetic+rhythmic` liked at t 4, then disliked at t 5, liked again at t 11, disliked at t 12, etc.). The current playbook only blocks *exact* reuse after a like, but the system still re‑uses the same combo after a single intervening vote (often a dislike) – the rule does not prevent short‑loop boredom.  
- **Advisor frequently proposes invalid combos**: 36 of 112 advisor calls yielded “no valid candidate” (≈32 %). This wastes turns and forces the learner to pick, lowering overall like‑rate. Many of these failures occur when the advisor tries to stay too close to the previous vote (e.g., listener 3, t 7‑9 produce empty candidate sets).  
- **Insufficient exploration of two‑feature shifts**: the prompt asks to “prefer changing one or two features from a liked combination,” but the transcripts show the advisor often makes either zero changes (repeats) or three‑plus changes (e.g., listener 5, t 16‑18 jump from `classical+piano+hopeful+sparse` to `classical+piano+dreamy+sparse` – a two‑feature shift that worked, but later the advisor reverts to zero‑change repeats). The balance is off.

**Three concrete improvements**  

1. **Strengthen the anti‑repeat rule** – add a short‑term memory: *do not propose any combination that appeared in the last two votes, regardless of like/dislike*. If the only valid candidates violate this, fall back to changing at least two features from the most recent liked combo. This directly tackles the 72‑replay boredom pattern.  

2. **Boost advisor validity with a novelty bonus and higher temperature** – set `noveltyBonus: 0.07` (reward combos that share ≤1 feature with the previous vote) and raise `temperature: 0.6`. The bonus encourages the LLM to explore sparsely‑seen feature pairs, while higher temperature reduces the chance of getting stuck in deterministic low‑variance outputs that cause the 32 % invalid‑call rate.  

3. **Introduce a “two‑feature shift” bias in the prompt** – replace the vague “prefer changing one or two features” with an explicit instruction: *Generate exactly three candidates; for each, start from the most recent liked combination and change either one or two features (never zero or three). If no liked combination exists in the window, change two features from the most recent disliked combo.* This gives the advisor a clear, enforceable exploration pattern that matches the observed success of two‑feature moves (listener 4, listener 5).  

Implementing these three changes should cut immediate replays, raise the proportion of valid advisor proposals, and steer the search toward the proven two‑feature‑shift moves that drive higher like rates.
