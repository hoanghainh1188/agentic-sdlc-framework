# 0.6 Writing style

The repo is written in English. Most readers are **not native English speakers**: Vietnamese colleagues today, Japanese clients later. Write so that they can read quickly and translate easily.

## Do

- Write **plain English**. Short sentences, one idea each.
- Use the **active voice** with a clear subject: "The tech lead approves the plan", not "The plan is approved by the tech lead".
- Prefer **verbs** to long noun phrases: "check the code", not "perform verification of the code".
- Use the **same word for the same thing** every time (see the glossary and the codes table). Do not vary words for style.
- Explain a technical term **the first time** it appears: "sandbox (an isolated environment)".
- Keep names, codes and commands exactly as they are: G1–G8, `sdlc`, GitHub, OpenBao.
- Use lists and tables for anything with more than two items.
- Put dates as `YYYY-MM-DD`.

## Avoid

| Avoid | Why | Write instead |
|---|---|---|
| Idioms: "low-hanging fruit", "move the needle", "boil the ocean" | Hard to understand and to translate | Say it directly: "easy wins", "improve", "try to do everything" |
| Phrasal verbs with several meanings: "set up", "carry out", "come up with" (when a simple verb exists) | Ambiguous for non-native readers | "configure", "do", "propose" |
| Long sentences with several clauses | Hard to follow | Split into 2–3 sentences |
| Vague words: "etc.", "various", "some" | Reader cannot act on them | List the items |
| "It", "this", "that" far from the noun | Unclear reference | Repeat the noun |
| Double negatives: "not uncommon" | Easy to misread | "common" |

## Tone by reader

| Reader | Tone |
|---|---|
| Leadership, clients | Polite and concise. No jargon without explanation |
| Delivery team | Direct and practical |
| Claude Code (`CLAUDE.md`, design docs) | Precise and imperative: "must", "never", "always" |

## Source tags

Mark where content comes from:
- ** **: internal project documents.
- **[External]**: outside source, with a link.
- **[Proposal]**: our suggestion, not yet backed by a source.

## Quick check before sending

1. Read one paragraph aloud. Fix where you stumble.
2. Any sentence longer than about 25 words? Split it.
3. Is every technical term explained on first use?
4. Would a Japanese reader using a translation tool understand it?

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-24 | Claude (draft) | Vietnamese style guide |
| 0.2 | 2026-09-24 | Claude (draft) | Replaced by an English style guide after the switch to English |
| 0.3 | 2026-09-24 | Claude (draft) | The handbook does not cite internal reference documents (Harry, 2026-09-24) |
