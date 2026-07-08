# Word Count Ratio Guard

Word count benchmarking checks whether a translation's word count falls within the expected expansion/contraction range for a given language pair. Output outside the bounds signals a likely quality problem.

Only English↔X bounds are defined. Non-English to non-English translations are bridged through English, so each leg (source→English, English→target) is checked independently against these bounds.

A ratio is `targetWordCount / sourceWordCount`. E.g. English→Hindi lower 1.15, upper 1.25 means 100 English words should yield 115–125 Hindi words.

## Language-pair expansion bounds

| source | target | lower | upper |
|--------|--------|-------|-------|
| english | hindi | 1.15 | 1.25 |
| english | marathi | 1.10 | 1.20 |
| english | bengali | 1.15 | 1.25 |
| english | gujarati | 1.10 | 1.20 |
| english | tamil | 1.20 | 1.30 |
| english | malayalam | 1.20 | 1.30 |
| english | odia | 1.15 | 1.25 |
| hindi | english | 0.80 | 0.87 |
| marathi | english | 0.83 | 0.91 |
| bengali | english | 0.80 | 0.87 |
| gujarati | english | 0.83 | 0.91 |
| tamil | english | 0.77 | 0.83 |
| malayalam | english | 0.77 | 0.83 |
| odia | english | 0.80 | 0.87 |

## Defaults and thresholds

- **Unknown language pair:** when the pair is not in the table above, use a default range of **0.8×–1.2×** (±20% around 1.0). Treat this as a soft check only — it is not a known/calibrated pair.
- **Minimum word threshold:** skip the word-count check entirely when the source has fewer than **30 words** (`MIN_WORDS_FOR_CHECK = 30`). Short texts produce unreliable ratios.
- **Localization tolerance:** same-language adaptation (localization) allows ±3% (`LOCALIZATION_TOLERANCE = 0.03`).
- **Poetry tolerance:** creative/poetic content uses a wider ±30% tolerance (`POETRY_TOLERANCE = 0.30`).

## Content types where benchmarking is auto-disabled

These content types have inherently variable output lengths, so ratio-based validation is unreliable and benchmarking defaults to OFF:

- **Poetry** (any form) — wider variability; ratio checks misleading.
- **Scripts** — any content type whose name contains the substring `script` (video scripts, film scripts, etc.), case-insensitive.
- **Traditional Hindu Astrological Report** — listed explicitly in `BENCHMARK_EXCLUDED_CONTENT_TYPES`.

Benchmarking also defaults OFF when no target language has a known (calibrated) ratio pair. It defaults ON only when at least one target language has known bounds AND the content type is eligible.

## How to apply

Compute the ratio `targetWords / sourceWords` for the leg being checked, then compare against the bounds for that language pair (or the 0.8–1.2 default for unknown pairs). Skip if the source has fewer than 30 words, or if the content type is poetry/script/astrological report.

- **Below the lower bound:** the output is too short. This usually means content was dropped or truncated, or the translation is overly literal/compressed. Re-check that nothing was omitted.
- **Above the upper bound:** the output is too long. This usually means the model hallucinated, padded, or added explanatory verbosity not present in the source. Re-check for invented content.
- **Within bounds:** length is consistent with the expected expansion/contraction for the pair.
