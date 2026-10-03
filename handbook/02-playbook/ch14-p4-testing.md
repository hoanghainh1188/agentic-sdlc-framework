# Chapter 14. P4 — Testing (G6)

> Readers: **testers, developers, Person B** · Reading time: about 15 minutes
> Status: **Draft 0.2**, awaiting Harry's comments.
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
- no critical finding (security findings at or above the configured severity go to HITL at any risk tier; default HIGH, and CRITICAL always);
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

Security findings at or above the configured severity (default **HIGH**; **CRITICAL always**, not configurable): HITL at every tier. Lower-severity findings are kept as evidence and G6 keeps the mode above. A higher threshold rarely helps: if every PR waits for a person, reviews turn into rubber-stamping (Chapter 19).

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

> Written by Claude Code together with the platform code (task C08, `design/ADR-M38-gate-g6.md`). §14.10.2 (how G6 reads CI) comes with the second part of C08.

### 14.10.1. The push and the pull request

When the platform passed G5 (Chapter 13 §13.10.5), the intent waits at **G6**. The platform then puts the agent's changes into a pull request by itself:

1. **It waits for the G5 block window.** While Person A can still send the changes back at G5, nothing leaves the platform.
2. **It pushes the checked changes.** The agent in its sandbox has no access to GitHub. The platform's runner takes the diff that G5 checked (never what the agent reports), makes **one commit** from it on the run's start commit, and pushes it to the branch `agent/INT-…`. The commit's author is `sdlc-agent`. The runner never pushes to the default branch, and never force-pushes; branch protection on the default branch also refuses it.
3. **It opens the pull request** from `agent/INT-…` into the default branch, or uses the open one, and posts a comment on the intent's issue: **the pull request is open**. The comment mentions Person B.

The pull request follows template T2:

- The description holds codes only: the intent code (with a link to its issue), the run ID, the agent, its version and model, the autonomy level, and the hashes of the approved plan and of the checked diff. It never holds the intent's title or description, file paths, or text from the agent: in a public repository everybody can read it.
- "AI wrote most / all of this change" is ticked, and so is "Only files in the approved plan were changed" (G5 checked it). The box "A human reviewed every file" is **never** ticked by the platform: the reviewer ticks it when approving (T2 rule).
- The author of the pull request is the platform's GitHub App, so Person B can approve it.
- Decide gates in comments on the intent's **issue**, not on the pull request.

**Later runs of the same intent** (for example after a request for changes) start from the commit the platform pushed, and push to the same branch: the same pull request shows the new commit.

**When the platform cannot push or open the pull request**, it tries again after a minute, up to three times in all. It stops at once when:

| Cause | Meaning |
|---|---|
| `empty_diff` | The run changed nothing |
| `diff_mismatch` | The stored diff is not the one G5 checked |
| `branch_moved` | Someone else changed the branch `agent/INT-…` |
| `publish_attempts` | Three attempts failed (GitHub, the runner, the token, or the pull request kept showing another commit) |

The intent is then **paused** at G6, and a **technical** escalation goes to Person B (Chapter 18). Acknowledge it, then decide:

| Decision | What happens |
|---|---|
| `resume` | The intent goes back to **G4**, and a new run starts after G4. After `branch_moved`, first restore the branch to the platform's last commit, or delete it |
| `modify` or `roll_back` | The intent goes back to **G3**, which is HITL from now on |
| `terminate` | The intent is closed (`cancelled`). Close the pull request if one is open |

**Platform operator:** the GitHub App needs Contents and Pull requests "Read and write" (`platform/GETTING-STARTED.md` Step 11), and the runner's evidence identity must be created again once after this update (runbook T11 §5g step 3b).

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
| 0.2 | 2026-09-25 | Claude (draft) | G6 security findings: configurable severity threshold, default HIGH, CRITICAL always (QUESTIONS #19) |
| 0.3 | 2026-10-03 | Claude Code (task C08, PR 1) | §14.10.1: the push and the pull request (ADR-M38 §2.1–§2.6, QUESTIONS #155, #156) |
