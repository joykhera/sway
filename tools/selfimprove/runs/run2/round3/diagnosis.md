**What worked**  
- The advisor’s candidates were liked slightly more often than the learner’s (40 % vs 33 %), showing that the LLM can surface useful feature combos when it consults the history.  
- In several episodes the advisor correctly identified a promising direction after a few warm‑up votes (e.g., listener 3’s early “classical+guitar+hopeful+sparse” liked, then the advisor kept proposing variations that stayed liked for many steps).  
- The “change one or two features from a liked combination” heuristic produced a steady stream of reasonable proposals, as seen in the many `[A]+`/`[A]-` pairs that differ by only one feature.

**What failed (with transcript evidence)**  
1. **Immediate repetition leads to boredom** – the log notes “same combination replayed right after a like: 113 times, disliked on replay 50 %”. Examples: listener 1 votes 1‑3 are all `electronic+strings+calm+sparse[L]+`; the advisor repeats it at 4 (liked) and 5 (disliked). Listener 8 shows the same pattern with `electronic+piano+calm+sparse`.  
2. **Over‑reliance on a single feature set** – many advisors keep looping around the same core (e.g., `jazz+guitar+hopeful+sparse` dominates listener 3’s transcript, producing long runs of likes then a sudden dislike when the listener’s hidden taste shifts).  
3. **Insufficient exploration of novel combos** – the advisor rarely proposes a “bolder” combination; most candidates differ by only one feature from the recent liked item, limiting the chance to discover higher‑reward regions (e.g., listener 6 never sees a combo with a new genre after the early dislikes).  
4. **No penalty for recently seen features** – the advisor sometimes suggests combos that reuse a feature that just caused a dislike (listener 2: after a dislike of `lofi+piano+hopeful+sparse[A]+` at 6, the advisor proposes the same again at 8 and 10).

**Three most promising specific changes**  

1. **Prompt update** – add an explicit anti‑repetition rule and a novelty encouragement:  
   *“Do not propose a combination that has appeared in the last 3 votes. When changing one or two features from a liked combo, ensure at least one of the changed features has not been used in the last 5 votes. Occasionally (≈1‑in‑4 proposals) submit a bolder combo that introduces a feature unseen in the last 10 votes.”*  

2. **Playbook lesson** – capture the repetition insight:  
   - *“If a combination receives a thumbs‑up, immediately vary at least one feature in the next proposal; repeating the same combo within two steps usually leads to a thumbs‑down.”*  
   - *“Track feature‑level dislike streaks; if a feature has been disliked in two consecutive votes, deprioritize it for the next advisor call.”*  

3. **Parameter tweaks** – increase exploration and novelty:  
   - Raise `noveltyBonus` from `0.0` to `0.10` (so the learner rewards truly new combos).  
   - Reduce `advisorEveryNVotes` from `3` to `2` to get more frequent LLM input when the listener’s taste may be shifting.  
   - Expand `historyWindow` from `12` to `24` to give the advisor a longer context for detecting repetition and feature fatigue.  

These changes directly address the observed boredom from immediate repeats, encourage the advisor to explore under‑used features, and give the learner a stronger signal to favor genuinely novel, high‑reward combinations.
