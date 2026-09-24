# T13 Task plan for agents

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | After the ADR, before any agent run |
| Filled by | Person A (agents may draft) |
| Stored in | `.sdlc/plans/INT-YYYY-NNNN.yaml` in the repository |
| Gate | G3 (plan approval), then G4 and G5 use it |
| Rules | [Chapter 12](../02-playbook/ch12-p2-analysis-and-design.md) §12.4, [Chapter 13](../02-playbook/ch13-p3-coding.md) |

---

## Template

```yaml
plan:
  intent_id: INT-YYYY-NNNN
  plan_version: 1
  spec_version: <vN>
  adr_refs: [ADR-NNNN]
  risk_tier: medium          # low | medium | high | critical
  data_class: internal
  autonomy_level: L2         # L0–L2 in the pilot
  approved_by: <Person B>    # filled at G3
  approved_at: <date>

tasks:
  - id: T1
    summary: <one line>
    owner_agent: coder        # planner | coder | tester | doc-writer | ...
    depends_on: []
    input: <spec sections, files>
    output: <code, tests, docs>
    allowed_paths:            # G5 blocks anything else
      - src/orders/**
      - test/orders/**
    tools: [read_repo, edit_files, run_tests, create_branch, open_pull_request]
    environments: [sandbox]
    definition_of_done:
      - AC-3 and AC-4 have passing tests
      - lint and type check pass
    required_evidence: [unit_tests, security_scan]
    limits:
      budget_usd: 5
      max_iterations: 30
      max_minutes: 60
    escalate_when:
      - a change outside allowed_paths is needed
      - the API contract must change
      - a new dependency is needed
      - the spec is unclear or conflicts with the code
    checkpoint: after each passing test run
```

## Check before G3

- [ ] Every task links to acceptance criteria
- [ ] `allowed_paths` are as narrow as possible
- [ ] Tools and environments are the minimum needed
- [ ] Limits set for every task
- [ ] Escalation conditions written
- [ ] The plan can be resumed after a failed task (checkpoints)

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
