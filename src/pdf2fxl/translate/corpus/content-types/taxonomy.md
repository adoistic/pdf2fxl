# Content-Type Taxonomy

The translation platform classifies source text into a content type. Types are
organized into ~18 categories (278 types total). The content type drives prompt
selection (cultural / specialty / script / temporal) and stance (literary vs
commercial).

The user picks a type from the taxonomy, searches by synonym/fuzzy match, or
supplies a free-form **custom context** (e.g. "19th Century Medical Journal",
"Ancient Sanskrit Manuscript"). A custom context always overrides auto-detection.

## Categories and Types

### Academic
- Academic Paper
- Research Paper
- Scientific Paper
- Journal Article
- Thesis/Dissertation
- Case Study
- Literature Review
- Abstract
- Bibliography
- Lecture Notes
- Conference Paper

### Business
- Business Document
- Financial Report
- Business Plan
- Contract
- Proposal
- Resume/CV
- Corporate Memo
- Executive Summary
- Annual Report
- Business Letter
- Invoice/Receipt
- SWOT Analysis

### Poetry
- Sonnet
- Haiku
- Free Verse
- Blank Verse
- Limerick
- Ballad
- Epic Poetry
- Ode
- Elegy
- Villanelle
- Sestina
- Tanka
- Acrostic
- Cinquain
- Pantoum
- Rondeau
- Ekphrastic Poetry
- Found Poetry
- Concrete Poetry
- Lyric/Song
- Pastoral
- Narrative Poetry
- Humorous Poetry
- Devotional Poetry
- Hagiographical Poetry
- Biographical Poetry
- Historical Poetry

### Scripts
- Film Script
- TV Script
- Animation Script
- Ad Script
- Play/Theater Script
- Video Game Script
- Voice-Over Script
- Comic Book Script

### Hindustani Poetry
- Ghazal
- Sher
- Nazm
- Qita
- Qasida
- Marsiya
- Masnawi
- Ruba'i
- Mazahiya Shayari
- Salam
- Geet
- Lori
- Manqabat
- Mukhammas
- Doha
- Sehra
- Paheli
- Ashaar
- Rekhti
- Hamd
- Naat
- Kafi

### Creative
- Fiction
- Drama Script
- Screenplay
- Novel/Book Chapter
- Short Story
- Prose
- Creative Nonfiction
- Dialogue
- Narrative
- Comedy Fiction
- Standup Comedy
- Parody
- Self-Help Book

### Journalism
- News Article
- Op-Ed
- Editorial
- Press Release
- Feature Article
- Column
- Interview Transcript
- Investigative Report
- Review
- Commentary

### Technical
- Technical Documentation
- Instructional/How-To
- User Manual
- API Documentation
- Technical Report
- Specification Sheet
- Code Documentation
- Product Description
- Technical Guide
- Training Material

### Digital & Marketing
- Blog Post
- Website Content
- Social Media Post
- Email Campaign
- Marketing Content
- SEO Content
- Product Description
- Landing Page
- Newsletter
- Advertisement Copy

### Legal
- Legal Document
- Contract
- Agreement
- Terms of Service
- Privacy Policy
- Legal Brief
- Patent Application
- Affidavit
- Legislation
- Court Ruling

### Personal
- Conversation
- Email
- Letter
- Journal/Diary
- Personal Statement
- Application Essay
- Memoir
- Recommendation Letter
- Personal Narrative

### Educational
- Textbook Content
- Lesson Plan
- Study Guide
- Exam/Test
- Educational Material
- Course Outline
- Quiz
- Tutorial
- Assignment
- Educational Assessment

### Philosophical & Religious
- Philosophical Text
- Religious Text
- Ethical Statement
- Theological Document
- Philosophical Argument
- Religious Commentary
- Doctrinal Statement
- Meditation/Prayer
- Sacred Text Translation
- Traditional Hindu Astrological Report

### Medical
- Medical Document
- Patient Record
- Medical Report
- Clinical Note
- Medical Research Paper
- Medical Brochure
- Healthcare Guidelines
- Medical Transcript
- Medical Course Material
- Medical Prescription
- Medical Educational Material

### Veterinary Medicine
- Veterinary Document
- Veterinary Record
- Veterinary Report
- Veterinary Clinical Note
- Veterinary Research Paper
- Veterinary Brochure
- Veterinary Guidelines
- Veterinary Transcript
- Veterinary Course Material
- Veterinary Prescription
- Veterinary Educational Material

### Alternative Medicine
- Ayurvedic Document
- Unani Document
- Yoga Text
- Siddha Document
- Homeopathy Document
- Naturopathy Document
- Chinese Medicine Document
- Acupuncture Guide
- Herbal Medicine Text
- Alternative Medicine Research
- Alternative Medicine Prescription
- Alternative Medicine Guidelines
- Alternative Medicine Course Material
- Alternative Medicine Educational Material
- Traditional Medicine Text

### Primary Documents
- Historical Manuscript
- Archival Document
- Historical Letter
- Diary/Journal
- Government Record
- Census Data
- Legal Record
- Military Record
- Personal Correspondence
- Diplomatic Cable
- Royal Decree
- Archaeological Text
- Church Register
- Land Deed
- Ship Manifest
- Trade Document
- Newspaper Archive
- Classified Document
- Primary Source Document

### Media & Communications
- Captions
- Subtitles
- Transcript
- Speech/Address
- Official Statement
- Interview Transcript

### Other
- Grant Application
- Manual
- Certificate
- Guideline
- Patent
- Other

### Temporal Translation
- Temporal Translation

Same-language translation across historical periods — rendering a text from one
era of a language into another era of the *same* language (e.g. Old English →
Modern English, Classical Arabic → Modern Standard Arabic, Middle English →
Contemporary English). There is no second language and no bridge language; the
source and target are the same tongue at different points in time.

## Auto-detection

When no content type is supplied, infer one from a sample of the source text.
Look for these category-level signals. **The user may always override** the
detected type by selecting a preset or entering a custom context description —
an explicit user choice wins over any inferred type.

- **Academic** — citation markers (e.g. "et al.", "[12]"), abstract/methodology/
  results sections, footnotes, a references list, formal hedged register.
- **Business** — figures and currency, fiscal-period language, terms like
  "stakeholder", "Q3", "executive summary", "deliverable", letterhead/memo headers.
- **Poetry** — short enjambed lines, stanza breaks, rhyme or meter, imagery-dense
  language, line breaks that are not sentence boundaries.
- **Scripts** — scene headers (INT./EXT.), CHARACTER NAME cues followed by
  dialogue, parentheticals, panel/page markers, speaker keys (FVO:, VO:).
- **Hindustani Poetry** — ghazal/sher couplet structure, radif/qafiya, Urdu-Hindi
  poetic vocabulary, devotional forms (naat, hamd, manqabat).
- **Creative** — narrative prose, character dialogue, scene-setting, first/third
  person storytelling, literary voice.
- **Journalism** — dateline, byline, inverted-pyramid lede, quotes attributed to
  sources, headline + standfirst.
- **Technical** — step-by-step instructions, code blocks, API/endpoint names,
  version numbers, specification tables, imperative "do X" register.
- **Digital & Marketing** — calls to action, SEO keywords, hashtags, promotional
  superlatives, headlines/subheads, brand voice.
- **Legal** — numbered clauses, "hereinafter"/"whereas"/"party of the first part",
  defined terms in quotes, section/sub-section hierarchy.
- **Personal** — salutation/sign-off, first-person intimate voice, informal tone,
  direct address to a named recipient.
- **Educational** — learning objectives, lesson/lecture structure, exercises and
  questions, explanatory definitions, assessment rubrics.
- **Philosophical & Religious** — argumentation and premises, scripture quotation,
  doctrinal/theological vocabulary, devotional or contemplative register.
- **Medical** — clinical abbreviations, drug names and dosages, anatomical terms,
  patient-record structure (HPI, Dx, Rx), measurements with units.
- **Veterinary Medicine** — animal/species references, breed terms, weight-based
  dosing, taxonomic names, veterinary clinical structure.
- **Alternative Medicine** — traditional-system vocabulary (Ayurveda, Unani,
  Siddha, TCM), herb names, preparation methods, traditional diagnostic terms.
- **Primary Documents** — archaic orthography, period datelines, manuscript/archival
  framing, historical names and places, deed/decree/register formats.
- **Media & Communications** — timecodes, caption/subtitle formatting, speech
  cadence, official-statement framing.
- **Temporal Translation** — source and target are the **same language** at
  different historical periods (the user asks to render Old/Middle/Classical →
  Modern, or vice versa), archaic orthography or morphology to be modernized
  in place, and no second/bridge language involved.
- **Other** — falls through when no category signal dominates.

## Stance mapping

The orchestrator reads this table to choose a default **stance** for the detected
or selected category. **Literary** stance favors meaning, voice, cultural
resonance and creative adaptation; **commercial** stance favors precision,
terminological consistency, clarity and message effectiveness.

| Category                   | Default Stance |
| -------------------------- | -------------- |
| Academic                   | commercial     |
| Business                   | commercial     |
| Poetry                     | literary       |
| Scripts                    | literary       |
| Hindustani Poetry          | literary       |
| Creative                   | literary       |
| Journalism                 | commercial     |
| Technical                  | commercial     |
| Digital & Marketing        | commercial     |
| Legal                      | commercial     |
| Personal                   | literary       |
| Educational                | commercial     |
| Philosophical & Religious  | literary       |
| Medical                    | commercial     |
| Veterinary Medicine        | commercial     |
| Alternative Medicine       | literary       |
| Primary Documents          | literary       |
| Media & Communications     | commercial     |
| Temporal Translation       | literary       |
| Other                      | commercial     |

Mapping rationale: poetry, religious/scripture, philosophy, classical &
historical material (Primary Documents, Alternative Medicine's traditional voice),
literary fiction (Creative, Personal), and temporal/period work take the
**literary** stance. Business, marketing, journalism, technical, legal, medical,
digital, and everyday prose take the **commercial** stance.

## Category guidance files

After choosing a stance, an agent resolves the detected content type to its
category and loads the **one** mapped guidance file below (or none). The stance
file governs register; the guidance file adds domain technique and
cultural-adaptation guidance.

| Category                   | Guidance file                              |
| -------------------------- | ------------------------------------------ |
| Academic                   | content-types/specialty.md                 |
| Business                   | — (none; use stance + grammar only)        |
| Poetry                     | poetry/forms.md                            |
| Scripts                    | content-types/scripts.md                   |
| Hindustani Poetry          | poetry/forms.md                            |
| Creative                   | content-types/cultural.md                  |
| Journalism                 | — (none; use stance + grammar only)        |
| Technical                  | content-types/specialty.md                 |
| Digital & Marketing        | — (none; use stance + grammar only)        |
| Legal                      | content-types/specialty.md                 |
| Personal                   | content-types/cultural.md                  |
| Educational                | — (none; use stance + grammar only)        |
| Philosophical & Religious  | content-types/cultural.md                  |
| Medical                    | content-types/specialty.md                 |
| Veterinary Medicine        | content-types/specialty.md                 |
| Alternative Medicine       | content-types/specialty.md                 |
| Primary Documents          | — (none; use stance + grammar only)        |
| Media & Communications     | — (none; use stance + grammar only)        |
| Temporal Translation       | content-types/temporal.md                  |
| Other                      | — (none; use stance + grammar only)        |

An agent resolves a detected content type to its category, then loads the mapped
guidance file (or none).

Note: comedy content types (Comedy Fiction, Standup Comedy, Parody — which sit
under the **Creative** category, so they load `content-types/cultural.md`) should
ALSO consult `content-types/specialty.md`'s Comedy section for timing/punchline
handling.
