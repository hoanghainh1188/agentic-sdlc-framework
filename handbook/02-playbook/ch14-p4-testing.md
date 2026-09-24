# Chapter 14. P4 — Testing (G6)

> Readers: **testers, developers, Person B** · Reading time: about 15 minutes
> Status: **Draft 0.1**, awaiting Harry's comments.
> Section 14.10 (platform usage) is written by Claude Code together with the platform code.

---

## 14.1. Purpose

- Get **independent evidence** that the change does what the specification says, and nothing harmful.
- Never rely on the producing agent checking its own work.

## 14.2. Scope

From the agent's pull request (end of P3) until G6 passes.

---

## 14.3. Principles

1. **Independent verification.** Tests, scans and validators run separately from the producing agent. A validator never edits what it checks; the producer never edits a validator's verdict.
2. **Machines first, people last.** Deterministic checks (format, lint, types, tests, scans) run before any AI reviewer or human reviewer.
3. **Tests check the business behaviour**, not only that code runs. Every acceptance criterion has at least one test.
4. **Evidence is tied to the exact commit.** A result for another commit is not evidence.
5. **No fake passes.** Tests that are skipped, mocked away or weakened to pass are a failure, not a pass.

---

## 14.4. Roles

| Role | In P4 |
|---|---|
| Test / security validator agents | Run independent tests and scans; generate additional test cases; report verdicts |
| CI | Runs the deterministic checks; stores results |
| Tester (QA) | Designs the test strategy for Medium+ risk; reviews failures; owns the test plan |
| Person B | Judges critical evidence (G6 for High+ risk); accepts or rejects residual risk |
| Person A | Fixes or sends back failures; decides on rework |

---

## 14.5. Steps

### Step 1 — Plan the tests (Medium risk and above)

- From the specification: one or more tests per acceptance criterion; negative and edge cases; non-functional checks where the spec requires them.
- Agents may generate test cases and **fake test data**. Never use real client personal data (Chapter 2).

### Step 2 — Run the checks

| Group | Checks |
|---|---|
| Deterministic | Format, lint, compile / type check, unit, integration, contract and end-to-end tests, migration dry-run |
| Security | Static analysis, dependency vulnerabilities, secret scanning, licence scanning, container and infrastructure-as-code scans, authorisation tests |
| Behaviour against the spec | Coverage of acceptance criteria; spec–code drift; API compatibility; architecture rules; business invariants |
| Operational (when the spec requires) | Performance, load, resilience, retries, timeouts, observability, rollback |
| Agent behaviour | Did the agent stay in scope? Did it add unexpected dependencies? Are its assumptions acceptable? |

Choose the depth by risk: Low risk needs the deterministic and security groups; higher risk adds the others.

### Step 3 — Gate G6: independent verification

**Pass** when:
- all required checks pass;
- no critical finding (security findings go to HITL at any risk tier);
- the evidence is tied to the right commit;
- every acceptance criterion traces to a passing test;
- no test result was faked or weakened by the agent;
- any remaining failure is accepted by a named owner, with a reason.

| On failure | Response |
|---|---|
| Fails, retries left | Back to the agent (P3) with the failure details |
| Fails, no retries left | Back to G3 (plan) or G2 (spec) — the problem is probably not the code |
| Critical security finding | Block; Person B and the security owner decide; no majority override |
| Validator and producer disagree | Freeze; Person B decides (Chapter 5 §5.6) |

- Oversight: Low → automated + AUDIT (sampled review); Medium → automated + HOTL; High and Critical → automated + **HITL by Person B**.

---

## 14.6. Mandatory artifacts

| Artifact | Content |
|---|---|
| Test report | Results per acceptance criterion; coverage; failures and their resolution |
| Security report | Scanner results with severity; accepted findings with owner and reason |
| Verification summary | For the pull request: what was checked, on which commit, what is left and who accepted it |

These become part of the **evidence pack** for the task.

---

## 14.7. Inputs and outputs

| Inputs | Outputs |
|---|---|
| Pull request and diff; approved spec and acceptance criteria; ADR and architecture rules; test plan; security policy; run record | G6 decision; test and security reports; verification summary |

---

## 14.8. Approval points

| Gate | Low | Medium | High | Critical |
|---|---|---|---|---|
| G6 | Automated + AUDIT | Automated + HOTL | Automated + HITL (Person B) | Automated + HITL (Person B) |

Security findings: HITL at every tier.

---

## 14.9. Tools

| Need | Tool |
|---|---|
| CI | GitHub Actions (or the client's CI) |
| Secrets | Gitleaks or equivalent |
| Code issues | Semgrep or CodeQL |
| Dependencies and containers | Trivy or equivalent |
| Test generation, test data | Approved AI tools / validator agents, fake data only |

---

## 14.10. Using the platform

> To be written by Claude Code together with the platform code: how G6 reads CI results, retry limits, the verification summary and the evidence pack.

---

## 14.11. Metrics

- First-pass qualification (Chapter 8 §8.5).
- Defect escape rate; change failure rate.
- Acceptance criteria without a test (target: zero).
- Critical findings released (target: zero).
- Retries per task before G6 passes.

---

## 14.12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The agent writes tests that confirm its own mistakes | Tests derived from the spec, not from the code; independent validators; tester review for Medium+ |
| Tests weakened or skipped to go green | Diff review of test changes; rule 14.3 (5) |
| Evidence from a different commit | Evidence bound to the commit; checked at G7 |
| Slow pipelines as agent output grows | Run affected tests first; deterministic checks before AI review |

---

## 14.13. References

**Related documents**
- Handbook: codes table §4; Chapters 2, 5, 8, 11, 13, 15, 17.
- `design/D-02` (G6 requirements), `design/D-09` (sample repo CI).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content; platform usage section reserved for Claude Code |
