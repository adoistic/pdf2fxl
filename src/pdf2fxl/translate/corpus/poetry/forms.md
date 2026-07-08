# Poetry Forms — Meter & Structure Preservation

When translating poetry, maintain beautiful poetic meter, rhythm, and form
consistent with the specific form. Each form below lists the preservation rule
the translator must honor.

## Western forms

### Sonnet
Sonnet structure with proper meter and rhyme scheme.

### Haiku
Haiku's traditional 5-7-5 syllable pattern.

### Villanelle
Villanelle's complex pattern with repeating lines.

### Sestina
Sestina's rotating pattern of six end-words.

### Ballad
Ballad's narrative style with strong rhythmic elements.

### Tanka
Tanka's 5-7-5-7-7 syllable pattern.

### Ode
Ode's elevated style and tone.

### Elegy
Elegy's solemn, reflective tone.

### Blank Verse
Blank verse's unrhymed iambic pentameter.

### Lyric/Song
Song-like qualities, maintaining rhythm and potential rhyme scheme.

### Acrostic
Acrostic form where first letters spell out a message.

### Humorous Poetry
Humorous tone while preserving any wordplay, puns, or satirical elements.

### Devotional Poetry
Devotional tone, spiritual imagery, and reverential language.

### Hagiographical Poetry
Hagiographical narrative style with devotional tone, poetic meter, and accurate
depiction of saints' lives and virtues, balancing poetic beauty with factual
precision.

### Biographical Poetry
Biographical narrative structure with poetic meter and rhythm, maintaining
factual accuracy about the subject's life while preserving artistic beauty and
emotional depth.

### Historical Poetry
Historical narrative form with proper meter and poetic beauty, ensuring accurate
representation of historical events, figures, and contexts while maintaining
artistic merit.

### Free Verse
Free verse style without imposing rigid meter or rhyme, but preserving line
breaks, spacing, and the poet's unique voice.

## Hindustani forms

### Ghazal
Ghazal's couplets with repeating refrain and specific meter (beher).

### Sher
Sher's two-line couplet format with complete thought and consistent meter.

### Nazm
Nazm's narrative style and prescribed meter.

### Qita
Qita's short, self-contained form with philosophical themes and repeated rhyme
pattern.

### Qasida
Qasida's formal metrical pattern with repeating refrain and multi-stanza
structure.

### Marsiya
Marsiya's elegiac tone with specific beher-e-kamil meter and refrain pattern.

### Masnawi
Masnawi's narrative style with rhyming couplets and refrain elements.

### Ruba'i
Ruba'i's four-line stanza with AABA rhyme scheme.

### Mazahiya Shayari
Mazahiya shayari's humorous tone and wordplay.

### Salam
Salam's devotional tone and formal metrical structure.

### Geet
Geet's lyrical style with melodic meter.

### Lori
Lori's soft and soothing lullaby rhythm.

### Manqabat
Manqabat's devotional praise structure and dignified tone.

### Mukhammas
Mukhammas's five-line stanza pattern.

### Doha
Doha's distinct meter with moral message.

### Sehra
Sehra's celebratory wedding poem style.

### Paheli
Paheli's riddle structure with rhythmic meter.

### Ashaar
Ashaar's individual verse style from parent poem.

### Rekhti
Rekhti's female voice with ghazal structure and refrain pattern.

### Hamd
Hamd's devotional structure praising Allah.

### Naat
Naat's devotional style praising Prophet Muhammad.

### Kafi
Kafi's musical rhythms and refrains with hypnotic call-and-response pattern
preserving the mystical essence.

## Fallback

For any poetry content type not listed above, preserve the original poem's
meter, rhythm, rhyme scheme, line breaks, and pentameter. It must always be
beautiful and poetic, and NOT free-verse types.

## Detection

Content is treated as poetry when the content-type string exactly matches one of
the following keywords (`isPoetryContent()`):

`Poetry`, `Sonnet`, `Haiku`, `Villanelle`, `Sestina`, `Ballad`, `Ghazal`,
`Tanka`, `Ode`, `Elegy`, `Blank Verse`, `Free Verse`, `Lyric/Song`, `Acrostic`,
`Pantoum`, `Rondeau`, `Cinquain`, `Ekphrastic Poetry`, `Found Poetry`,
`Concrete Poetry`, `Pastoral`, `Narrative Poetry`, `Humorous Poetry`,
`Devotional Poetry`, `Epic Poetry`, `Hagiographical Poetry`,
`Biographical Poetry`, `Historical Poetry`

Hindustani poetry forms also detected:

`Sher`, `Nazm`, `Qita`, `Qasida`, `Marsiya`, `Masnawi`, `Ruba'i`,
`Mazahiya Shayari`, `Salam`, `Geet`, `Lori`, `Manqabat`, `Mukhammas`, `Doha`,
`Sehra`, `Paheli`, `Ashaar`, `Rekhti`, `Hamd`, `Naat`, `Kafi`
