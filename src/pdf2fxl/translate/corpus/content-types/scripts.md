# Script Content (Dubbing, Voice-Over, Comics)

Script content covers Film, TV, Ad, Animation, Voice-Over, and Comic Book scripts.
Each branch has a translation pass and a localization (verification) pass. A
shared concern is **character names**: by default DO NOT translate them (keep them
exactly as in source); if the user opts in to name translation, translate them to
appropriate target-language equivalents. On the localization pass, if names were
accidentally translated when they should not have been, revert them.

## Standard Scripts (Film / TV / Ad / Animation) — Dubbing

This translation is intended for **DUBBING**. Timing and lip-sync plausibility
matter.

Translation pass — critical dubbing instructions:
1. **Spoken Naturalness** — The text must sound natural when SPOKEN, not just
   read. Use colloquialisms where appropriate for the character.
2. **Timing/Length** — Aim for a translation that takes roughly the same amount of
   time to say as the original source.
3. **Formatting** — Preserve the script format (Scene headers, Character names,
   Dialogue, Parentheticals) exactly.
4. **Scene Headers** — Translate standard terms like INT./EXT. to their
   target-language standard equivalents (e.g. AND/BAHAR in Hindi) ONLY if standard
   industry practice in the target language.
5. **Parentheticals** — Translate visual/action instructions naturally.

Tone: Match the emotional tone and intensity of the original performance.

Localization (verification) pass — focus:
1. **Dialogue Flow** — Ensure dialogue flows naturally for actors. Remove any
   "written" or "literary" stiffness.
2. **Cultural Nuance** — Adapt idioms and cultural references to resonate with the
   target audience while keeping the original context.
3. **Lip-Sync Constraints** — Choose words that match the mouth movements of the
   original actors roughly, if possible (open vowels for open mouths, plosives for
   closed lips).
4. **Timing** — The line lengths MUST match the original timing constraints.

## Voice-Over Scripts — Speaker Keys

Voice-Over is a special mode of the standard script flow. The defining rule:
**speaker keys/labels are NOT translated.**

> **SPEAKER KEYS/LABELS**: DO NOT TRANSLATE SPEAKER KEYS (e.g., "FVO:", "VO:",
> "Husband:", "Wife:", "MHW:").
> - These keys are used by automated software and MUST remain exactly as in the
>   source.
> - Translate ONLY the dialogue content after the key.
> - Example:
>   Source: "FVO: Hello world"
>   Target: "FVO: [Translated Hello world]"

Localization (verification) pass for voice-over:

> **SPEAKER KEYS/LABELS**: ENSURE ALL SPEAKER KEYS (e.g. "FVO:", "VO:",
> "Husband:") are UNTRANSLATED.
> - If the translator translated the key (e.g. "Pati:" instead of "Husband:"),
>   REVERT IT to the exact English key from the source.
> - The automated system requires the exact original keys.

## Comic Book Scripts — Panels & Sound Effects

Comic books have unique constraints due to visual-text integration and panel-based
storytelling. The input may be structured, semi-structured, or unstructured.
**Preserve the exact structure while translating the content.**

### Critical formatting preservation rules

1. **Preserve all structural elements**:
   - **Page markers**: Keep exactly as-is (e.g., "Page 1", "Page 2", "पेज 1")
   - **Line numbers**: NEVER translate or remove (e.g., "1.", "2.", "3.")
   - **Panel numbers**: Keep exactly (e.g., "PANEL 1", "Panel 3")
   - **Numbering format**: Maintain the exact format (1., 2., 3. OR 1, 2, 3 OR
     Panel 1, Panel 2)
   - **Indentation**: Preserve all indentation and spacing
   - **Line breaks**: Keep all line breaks exactly as in the source
   - **Blank lines**: Maintain blank lines between sections

2. **Handle semi-structured formats**:
   - Scripts may mix dialogue, stage directions, and narration without clear
     labels
   - Identify text type from context (character names, parentheticals, narrative
     voice)
   - Translate content while preserving the original structure
   - If a line starts with a number (1., 2., etc.), keep that number exactly

3. **Character names and stage directions**:
   - Character names may appear with or without labels
   - Stage directions may be in parentheses: (like this)
   - Translate stage directions/actions in parentheses naturally
   - Keep character name formatting consistent with source

4. **Speech bubble constraints**:
   - Keep dialogue CONCISE. Speech bubbles have strict space limits.
   - If original dialogue is long, condense while maintaining meaning
   - Aim for 20-30 characters per speech bubble line maximum
   - Prioritize clarity and impact over literal translation

5. **Sound effects (SFX)**:
   - ALWAYS LOCALIZE sound effects to target-language conventions
   - DO NOT keep English sound effects like "BOOM", "CRASH", "POW"
   - Use culturally appropriate onomatopoeia for the target language
   - Examples for reference:
     * Explosion: English "BOOM" → Hindi "धमाका" / "धड़ाम" → Japanese "ドカーン"
     * Punch: English "POW" → Hindi "धप्प" → Japanese "バキッ"
     * Crash: English "CRASH" → Hindi "धड़ाम" / "गड़गड़" → Japanese "ガシャン"
   - Maintain the VISUAL IMPACT and intensity of the original SFX

6. **Text types — identify and handle each differently**:
   - **DIALOGUE** (speech bubbles): Translate naturally, keep concise
   - **THOUGHT BUBBLES**: Translate, can be slightly longer than dialogue
   - **CAPTIONS/NARRATION**: Translate, maintain narrative voice
   - **STAGE DIRECTIONS** (in parentheses): Translate naturally
   - **PANEL DESCRIPTIONS**: Translate if they describe action/setting
   - **PAGE/PANEL MARKERS**: DO NOT translate the markers themselves

7. **Cultural adaptation**:
   - Adapt idioms and cultural references to target-language equivalents
   - Maintain character personality and voice consistency
   - Consider the visual context when choosing words
   - Preserve humor, wordplay, and emotional beats (adapt if needed)

8. **Emphasis and lettering**:
   - If text is in ALL CAPS (shouting), keep it in ALL CAPS
   - If text is in bold/italics, preserve that emphasis
   - Note any special lettering instructions in the original

### Example input/output structure

Input:
```
Page 1

1.  Character is running in the park.
2.  (Character looks worried)
3.  Character: I need to hurry!
```

Output:
```
Page 1

1.  [Translated: Character is running in the park]
2.  ([Translated: Character looks worried])
3.  Character: [Translated: I need to hurry!]
```

Tone: Match the genre (superhero, manga, indie, educational, etc.) and emotional
intensity of the original.

### Comic localization (verification) pass — focus

1. **Structure verification (HIGHEST PRIORITY)** — Page markers identical to
   source ("Page 1" stays "Page 1"); line numbers preserved exactly (1., 2., 3.);
   blank lines match source spacing; indentation matches source. If ANY structural
   element is missing or changed, RESTORE IT.
2. **Readability optimization** — Comic readers scan text rapidly while viewing
   art. Remove awkward phrasing; prioritize punchy, impactful language.
3. **Sound effects verification** — Verify ALL SFX are localized to the target
   language with the same VISUAL WEIGHT and IMPACT. If any English SFX remain
   (BOOM, POW, etc.), replace them with target-language equivalents.
4. **Speech bubble length check** — Condense any dialogue too long for a bubble;
   maintain meaning while reducing word count.
5. **Cultural resonance** — Adapt references, idioms, and humor so jokes land with
   target readers; maintain character voice and genre conventions.
6. **Visual-text harmony** — Consider how text appears in bubbles; avoid overly
   long words; preserve emphasis (caps, bold); maintain rhythm and pacing.
7. **Consistency check** — Consistent character voices and terminology (powers,
   locations); tone matches the visual style.

Final check: Before completing, verify the output structure EXACTLY matches the
input structure.
