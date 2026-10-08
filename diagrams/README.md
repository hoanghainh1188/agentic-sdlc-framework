# Diagrams

| Code | Name | Used in | Source | SVG | Status |
|---|---|---|---|---|---|
| D1 | Overview: 6 phases + 8 gates, oversight by risk | README, Ch.1, Ch.10 | [src](src/d1-overview-6-phases.mmd) | [svg](svg/d1-overview-6-phases.svg) | ✅ Approved |
| D2 | Five agent autonomy levels (L0–L4) | Ch.4 | — | — | ⬜ |
| D3 | AI code review flow | Ch.11, Ch.15 | — | — | ⬜ |
| D4 | Pilot roadmap | Ch.1, Ch.7 | — | — | ⬜ |
| D5 | Data flow and security boundaries | Ch.3 | — | — | ⬜ |
| D6 | Handling AI mistakes | Ch.5 | — | — | ⬜ |
| D7 | Japanese → Vietnamese requirements with AI | Ch.9 | — | — | ⬜ |
| D8 | Requirements ↔ design ↔ code ↔ test loop | Ch.8 | — | — | ⬜ |
| D9 | Token flow through the LLM gateway | design/D-07 | [src](src/d9-token-flow-gateway.mmd) | [svg](svg/d9-token-flow-gateway.svg) | ✅ Approved |
| D10 | MVP end-to-end flow | design/D-02 | [src](src/d10-mvp-flow.mmd) | [svg](svg/d10-mvp-flow.svg) | ✅ Approved |
| D11 | MVP architecture | design/D-03 | [src](src/d11-mvp-architecture.mmd) | [svg](svg/d11-mvp-architecture.svg) | ✅ Approved |
| D12 | Gate state machine G1–G8 | design/D-03 | [src](src/d12-gate-state-machine.mmd) | [svg](svg/d12-gate-state-machine.svg) | ✅ Approved |
| D13 | MVP entity-relationship diagram | design/D-05 | [src](src/d13-mvp-erd.mmd) | [svg](svg/d13-mvp-erd.svg) | ✅ Approved |

Colour conventions:
- Light red: gate always approved by a person (HITL).
- Light orange: oversight depends on the risk tier (codes table §4).
- Light blue: automatic policy check; a person steps in when a limit is breached.
- Grey: work done by AI.
- Yellow, dashed border: note.

File names: `dN-short-name.mmd`. The SVG has the same name.

## Rendering and the CI check

- The author renders the SVG and commits it in the same pull request as the `.mmd` change: `pnpm diagrams:render` (all diagrams) or `pnpm diagrams:render d12-gate-state-machine` (one). It needs Docker: it runs mermaid-cli from an image pinned by version and digest (`scripts/diagrams.py`), without network.
- The first line of each SVG is `<!-- source-sha256: … -->`: the SHA-256 of its `.mmd` file.
- CI does not render and never commits. `pnpm diagrams:check` (the `scan` job, no Docker) fails when a `.mmd` has no SVG, an SVG has no `.mmd`, the stamp does not match the `.mmd`, or an SVG is not well-formed XML with an `<svg>` root.
- The check does not compare the drawing: Chromium lays out text slightly differently on each build (for example an arm64 Mac and amd64 CI), so a byte comparison would make CI flaky. It also does not prove that the SVG was rendered by the tool: an SVG edited by hand that keeps its stamp would pass. Hand edits are unlikely; reviewers should not accept one.
Diagrams D9–D13 are copies of the Mermaid blocks in the design docs: when a design doc changes, update the `.mmd` file too.

## Progress snapshot

[status/platform-status.svg](status/platform-status.svg): the MVP architecture (design/D-03 §4) coloured by build progress, with progress per milestone. It is drawn by hand, not generated from Mermaid, and shows one date (in its subtitle): the current drawing is of **2026-10-06** and does not show the work merged after that date. Update it after a milestone or when asked; the source of truth for progress is the GitHub issues of the D-08 tasks.
