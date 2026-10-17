**What worked**  
- Advisor‑generated combos earned a higher like rate (44 %) than the learner’s (31 %).  
- In listeners 4 and 5 the advisor quickly converged on a stable, liked pattern (e.g., *lofi+guitar+hopeful+sparse* and *lofi+strings+calm+rhythmic*) and kept proposing variations that continued to receive thumbs‑up.  
- When the advisor did produce valid candidates, the “change one or two features from a liked combo” heuristic seemed to resonate (see listener 1’s run of likes on *ambient+percussion+hopeful+rhythmic* followed by small tweaks).

**What failed**  
- The advisor frequently returned **no valid candidate**: 36 out of 72 calls (50 %) yielded `call:ok,0`. This suggests the prompt or sampling often produced feature sets that violated constraints (duplicates, illegal IDs, or repeats).  
- **Repeat boredom** is evident: the same combination replayed right after a like occurred 74 times and was disliked 39 % of the time. With `repeatPenalty=0` the system has no disincentive to re‑serve a recently liked sound, leading to rapid drop‑off (listener 2, 6, 8 all stay below 20 %).  
- Low overall scores for listeners 2 (12 %), 6 (16 %), and 8 (4 %) show the advisor struggled to discover any rewarding region in those spaces, likely because it kept proposing invalid or overly repetitive combos instead of exploring.

**Three concrete changes**  

1. **Add a repeat penalty** – set `repeatPenalty=0.25` (or higher). This will subtract from the score of any candidate that exactly matches the most recent voted combination, directly addressing the 74‑repeat/39‑dislike pattern.  

2. **Boost advisor validity and novelty** – increase `llmCandidateBonus` to `0.15` (making advisor candidates more competitive) and add `noveltyBonus=0.08`. Simultaneously reduce `temperature` to `0.25` to sharpen the LLM’s output, which should lower the frequency of `call:ok,0` invalid proposals.  

3. **Tighten the advisor prompt** – add an explicit instruction: *“Never propose the exact same feature list as the last voted combination, even if it was liked.”* Keep the existing guidance to change one or two features from a liked combo and occasionally propose a bolder combo, but now the “never repeat” rule is enforced, reducing wasted calls and boredom.  

These adjustments target the observed failures (invalid proposals and repetition) while preserving the advisor’s strength in exploiting liked patterns.
