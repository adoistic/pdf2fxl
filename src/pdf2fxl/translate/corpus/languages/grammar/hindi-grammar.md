# Critical Grammar Concepts for Hindi (हिन्दी) Translation

## ⚠️ CRITICAL: Translation is Context-Dependent, NOT Literal

### **The "Context-First" Rule**
Hindi is a nuanced language with a complex relationship between verb agreement and case markers. Directly translating English syntax into Hindi results in robotic prose. You must think in terms of **Actions (Kriya)** and **Agreements (Sambandh)**.

### **The Article Logic (A/An vs The)**
Hindi does not use articles ('a' / 'the') in most cases.
- **A book** -> पुस्तक (Pustak) or एक पुस्तक (Ek pustak - only if count is the focus).
- **The book** -> Context-dependent. Use 'Woh' (That) only if specifically referring back to a previously mentioned item.

---

## 1. Compound Verbs (Ranjak Kriya) - **TECHNICAL DEEP DIVE**

Hindi relies on "Helping Verbs" (V-2) to add psychological or aspectual nuance. Using only simple verbs is the hallmark of machine translation.

### The Essential V-2 Matrix
| V-2 Verb | Meaning Shift | Example | Nuance |
| :--- | :--- | :--- | :--- |
| **लेना (Lena)** | For self / Completion | **मैंने पढ़ लिया** | I finished reading (for myself). |
| **देना (Dena)** | For others / Outward | **मैंने बता दिया** | I told (them). |
| **जाना (Jana)** | Finality / Accident | **शीशा टूट गया** | The glass broke (completely). |
| **बैठना (Baithna)**| Stupidity / Suddenness | **वह कह बैठा** | He blurted it out (regrets it). |

---

## 2. Ergativity (The 'Ne' Rule) - **CORE SYNTAX**

In the past tense of Transitive verbs, the subject takes the particle **'ने' (ne)** and the verb **forgets** the subject. It must agree with the **Object**.

- **Subject (M) + Object (F):** "लड़के ने (M) रोटी (F) **खाई** (F)." 
- **Subject (F) + Object (M):** "लड़की ने (F) आम (M) **खाया** (M)."

---

## 3. Linguistic Decision Protocol: Hindi

When translating into Hindi, follow this specific thought sequence:

1. **Agent Marking Check:** Is the action in the past? Is the verb transitive? If yes, apply **'ने' (ne)** to the subject and ignore it for verb agreement.
2. **Oblique Check:** Is there a postposition (ka/ki/ko/se/mein/par) after the noun? If yes, shift the noun to **Oblique form** (Larka -> Larke).
3. **Natural Flow Check:** Does the sentence contain a simple verb where a **Compound Verb (V-2)** would be more natural? (e.g., use 'kar diya' instead of just 'kiya').
4. **Article Removal:** Strip English articles (a/an/the) unless they are used for absolute numerical emphasis.
5. **Honorific Consistency:** Choose ONE tier (Aap/Tum/Tu) and maintain it throughout the entire segment.

---

## Few-Shot Examples (Context-Aware)

### Example 1: Inspiring Tone
- **English:** "Small things make a big difference."
- **✓ Natural:** "**छोटी-छोटी बातों से ही बड़े बदलाव आते हैं।**"

### Example 2: Expressing Health
- **English:** "I have a headache."
- **✓ Natural:** "**मेरे सिर में दर्द है।**" or "**मुझे सिरदर्द हो रहा है।**"

**Your goal: NATURAL, CONTEXTUAL translation - not perfect rule-following.**
