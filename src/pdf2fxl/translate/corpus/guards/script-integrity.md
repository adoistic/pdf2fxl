# Script Integrity Guard

Three always-on deterministic checks that run on translation output. Each is a hard, mechanical rule — no judgment calls. A single violation fails the check.

## (a) Urdu output must contain NO Devanagari

When the target language is Urdu (name contains "urdu" or "اردو"), the output must contain **zero Devanagari characters** (Unicode range **U+0900–U+097F**).

- **ABSOLUTE ZERO TOLERANCE.** Any single Devanagari character = immediate fail (`hasIssues = true`, `wrong_script` error).
- LLMs are highly prone to leaking Hindi/Devanagari into Urdu because of linguistic similarity and Hindi's larger training data, so this check takes priority over every other Urdu check.
- Examples of critical fails: `रक्षा`, `संरक्षण`, `हिन्दी`, `देवनागरी`, or any word containing क, ख, ग, घ, च, छ, ज, etc. Even one character like `क` or `ह` (or a vowel sign like ा, ि, ी) in Devanagari fails.
- The Urdu output must also actually contain Urdu script (Unicode U+0600–U+06FF / U+0750–U+077F); pure non-Urdu output is itself a failure.

**How to apply:** Scan the entire output for any codepoint in U+0900–U+097F before any other Urdu check. If found, fail immediately and report `wrong_script`. Do not pass the translation downstream.

## (b) Numeral preservation (when requested)

When numeral preservation is requested, all numerals in the output must match the source **exactly** — same count and same values. Never convert digits to words, never change format.

Numerals covered:

- **Arabic numerals:** integers (`0`–`100`, `1000`, …), decimals (`3.14`, `0.5`), thousands-separated (`1,000`), negatives (`-10`), percentages (`50%`, `99.9%`), fractions (`1/2`, `3/4`), and numerals inside dates, times, measurements, currency, ordinals, page/chapter numbers, and list numbers. Detection pattern: `\b\d+(?:[,.]\d+)*\b`.
- **Roman numerals:** uppercase and lowercase `I, V, X, L, C, D, M` (e.g. `IV`, `XIV`, `MCMXCIV`, `iii`). Detection pattern: `\b[IVXLCDM]+\b` (case-insensitive).

Rules:

- **Never translate numerals:** keep `123` as `123` (not "one hundred twenty-three"); keep `IV` as `IV` (not "four" or "4"); keep `2024` as `2024`.
- **Never convert format:** Arabic stays Arabic, Roman stays Roman, ordinals stay as-is (`1st` stays `1st`, not "primeiro").
- **Preserve context:** in `January 5, 2024` translate month words but keep the numbers; keep `3:30 PM` exact; keep currency symbol+amount (`$1,500.50`); for `Page 5` translate "Page" but keep `5`.

**How to apply:** Extract Arabic and Roman numerals from source and from output. The count of each type must match. Every numeral value present in the source must also be present (unchanged) in the output. Any count mismatch, or any source numeral missing/altered in the output, is a failure.

## (c) Markdown structure preservation

When the source contains markdown, the output must preserve the **exact same structure** — only the visible text is translated. Markdown syntax is never altered, and code content is never translated.

Checked elements:

- **Headings:** exact same number of `#` symbols per heading. `## Heading` → `## Überschrift`, never `# Überschrift`. Heading-level counts must match between source and output.
- **Bold / italic:** preserve the exact marker (`**` vs `__`, `*` vs `_`); apply to the translated text. `**bold**` → `**fett**`.
- **Tables:** keep exact column count, the header separator row (`|---|---|`), and alignment markers (`:---`, `:---:`, `---:`). Translate cell content only, never the structure.
- **Code blocks:** **never translate content inside code blocks** (fenced ``` or inline `` ` ``); preserve language specifiers (e.g. ```` ```javascript ````).
- **Lists:** keep list markers (`-`, `*`, `+`, or numbered) and indentation/nesting; keep task checkboxes `- [ ]` / `- [x]`.
- **Links:** translate link text only; **never modify URLs**. `[click here](url)` → `[klicken Sie hier](url)`.
- **Blockquotes:** keep exact `>` nesting; translate quoted text only.
- **Line breaks:** preserve paragraph breaks (double newline) and intentional line breaks (two trailing spaces + newline).

If the source has markdown but the output has none, that is an automatic failure (formatting was lost).

**How to apply:** Detect markdown elements in source and output and compare counts by type (and by heading level). Headings, bold, italic, tables, lists, code blocks, blockquotes, links, and images must all match. A missing element (output count < source count) is a failure; an extra element is a warning. Confirm code blocks are untranslated and all URLs are byte-for-byte unchanged.
