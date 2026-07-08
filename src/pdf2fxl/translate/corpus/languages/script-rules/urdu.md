# Urdu Script & Phonetic Accuracy Rules

These rules apply ONLY when the target language is Urdu (any variant — the string
contains `urdu` or `اردو`). They address the most common AI translation errors in
Urdu script. Exercise special care: these errors are EXTREMELY common.

> HARD RULE: Urdu output must use proper Urdu/Persian (Arabic) script throughout
> and contain ZERO Devanagari characters (Unicode U+0900–U+097F). No Latin
> transliteration either.

## 1. Prevent split phoneme errors

Do NOT split syllables or phonemes into separate words. Write words as complete
units.

- ❌ WRONG: با ہن (ba han) for "sister"
  ✓ CORRECT: بہن (bahan as one word)
- ❌ WRONG: کا ہانی (ka haani) for "story"
  ✓ CORRECT: کہانی (kahaani as one word)
- ❌ WRONG: اس مان (as maan) for "sky"
  ✓ CORRECT: آسمان (aasmaan as one word)

Rule: Keep Romanized syllables together as single Urdu words. Do NOT insert
spaces within word boundaries.

## 2. Handle aspirated consonants correctly

Aspirated sounds (bh, dh, gh, kh, ph, th, chh) are single phonetic units. Use the
correct Urdu compound letters: بھ، دھ، گھ، کھ، پھ، تھ، چھ

- ❌ WRONG: بائی (baa-ee) for "brother"
  ✓ CORRECT: بھائی (bhai with aspirated bh)
- ❌ WRONG: دو کا (do ka) for "deception"
  ✓ CORRECT: دھوکہ (dhoka with aspirated dh)
- ❌ WRONG: کھش (khsh) for "happy"
  ✓ CORRECT: خوش (khush - use correct letter)

Rule: Use proper aspirated compound letters (ب + ھ = بھ, د + ھ = دھ, etc.) not
separate letters.

## 3. Preserve nasalization & ending vowels

Nasalized sounds (-an, -ain, -on, -een) require specific Urdu script markers —
nun ghunna ں or noon ن.

- ❌ WRONG: ان سن (an san) for "human"
  ✓ CORRECT: انسان (insaan as one word)
- ❌ WRONG: جا ن (ja n) for "life"
  ✓ CORRECT: جان (jaan as one word)
- ❌ WRONG: کا ہین (ka hain) for "somewhere"
  ✓ CORRECT: کہیں (kahin with proper nasalization)

Rule: Use nun ghunna (ں) for final nasal sounds. Never split nasal endings.

## 4. Choose correct letters for homophones

Many Urdu letters represent similar sounds but differ by context. Choose the
contextually appropriate letter.

- ❌ WRONG: ڈل (dal) for "heart"
  ✓ CORRECT: دل (dil - use د not ڈ)
- ❌ WRONG: کال (kaal with long aa) for "yesterday/tomorrow"
  ✓ CORRECT: کل (kal - short vowel)
- ❌ WRONG: حم (hum with ح) for "we"
  ✓ CORRECT: ہم (hum with ہ)

Rule: Use the standard literary Urdu letter choice for common words, not phonetic
alternatives.

## 5. Include proper diacritics (harakat) when needed

While Urdu often omits short vowels, include diacritics (zabar َ , zer ِ ,
pesh ُ ) for ambiguous words.

Example distinctions:
- کتاب (kitaab = book) vs کتب (kutub = books)
- شاعر (shaa'ir = poet) vs شیر (sher = lion)
- قسمت (qismat = fate) — use correct vowel patterns

Rule: For ambiguous words, add vowel diacritics to prevent misreading.

## 6. Keep compound expressions & idioms intact

Do not split idiomatic phrases or compound expressions into separate disconnected
words.

- ❌ WRONG: دیل سے (dail se) for "from the heart"
  ✓ CORRECT: دل سے (dil se - correct first word)
- ❌ WRONG: اپ نا کام کرو (ap na kaam karo - wrong split)
  ✓ CORRECT: اپنا کام کرو (apna kaam karo - correct word boundaries)
- ❌ WRONG: خادہ حافظ (wrong letters/split)
  ✓ CORRECT: خدا حافظ (khuda haafiz - correct letters)

Rule: Research proper Urdu idioms and compound expressions. Maintain correct word
boundaries.

## Verification checklist for every Urdu translation

Before finalizing, verify:

- ✓ No syllables split across word boundaries (no "ba han", must be "bahan")
- ✓ All aspirated sounds use compound letters (بھ not ب + ھ separately)
- ✓ Nasalization markers placed correctly (ں for nasal endings)
- ✓ Contextually appropriate letter choices (دل not ڈل, ہم not حم)
- ✓ Diacritics added where needed for clarity
- ✓ Idiomatic phrases kept as standard units
- ✓ Proper Urdu/Persian script used throughout (not Devanagari or Latin)

## Execution requirements (Phase 2)

Execute the translation with strict Urdu phonetic and script accuracy:

1. Write Complete Words — never split syllables within word boundaries
2. Use Compound Letters — apply proper aspirated consonant forms (بھ، دھ، گھ، کھ، پھ، تھ، چھ)
3. Apply Nasalization — use nun ghunna (ں) for nasal endings correctly
4. Choose Correct Letters — use contextually appropriate Urdu letters for homophones
5. Preserve Idioms — maintain standard Urdu forms for compound expressions

Validate each Urdu word against the common error patterns before finalizing.
