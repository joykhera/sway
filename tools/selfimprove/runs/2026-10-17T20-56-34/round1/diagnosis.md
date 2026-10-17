**What worked**  
- The advisor’s candidates are liked slightly more often than the learner’s (44 % vs 34 %), showing that the LLM can sometimes surface useful feature combos.  
- In several listeners (e.g., listener 2, listener 5) the advisor hit on a stable “core” combo that produced a run of likes before the listener grew bored, indicating the advisor can identify a preferred region of the feature space when it stays consistent long enough.

**What failed**  
- **Repetition boredom:** The same combination was replayed immediately after a like 83 times and disliked on replay 55 % of those repeats. Examples: listener 1’s endless loop of `ambient+synth+energetic+rhythmic` and `jazz+guitar+dreamy+sparse`; listener 2’s `classical+guitar+dreamy+rhythmic`; listener 5’s `lofi+piano+dreamy+sparse`.  
- **Insufficient exploration:** The advisor rarely deviates from the current “stuck” combo; the playbook is empty, and `noveltyBonus` is set to 0, so there is no explicit reward for trying new features.  
- **Low overall utility:** Mean score after warm‑up is only 41.5 %, far below a useful recommendation level, driven by the repetitive dislikes above.

**Three concrete changes to improve performance**

1. **Add a novelty incentive** – set `"noveltyBonus":0.10` (or higher) in the params. This will give the deterministic chooser a small boost to candidates that contain at least one feature not seen in the last `historyWindow` votes, encouraging the advisor to break out of loops.

2. **Teach the advisor to avoid immediate repeats** – add a rule to the playbook:  
   *“Do not propose a combination that appeared in the previous vote if it was liked; if it was disliked, change at least two features before re‑using it.”*  
   This directly targets the 83‑repeat pattern observed in the transcripts.

3. **Prompt the LLM to seek “bold” alternatives** – modify the advisor prompt to read:  
   *“Prefer changing one or two features from a liked combination, but also consider changing features from a disliked combo to avoid repetition. Occasionally propose a bolder combination that introduces a feature not present in the last 6 votes.”*  
   This nudges the LLM toward exploration while still respecting the heuristic of small tweaks.

Implementing these three adjustments should reduce repetitive dislikes, increase the chance of discovering new liked patterns, and raise the overall hit‑rate well above the current 41 % baseline.
