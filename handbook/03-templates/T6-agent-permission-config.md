# T6 Agent charter, register entry and permission configuration

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | Proposing a new agent; registering it; changing its permissions |
| Filled by | Technical owner of the agent (often Person A) |
| Stored in | Charter: `docs/agents/<agent-id>.md`; register: `docs/agents/register.md` |
| Related | Agent approval and recertification (Ch.20); G4 |
| Rules | [Chapter 20](../02-playbook/ch20-agent-and-model-lifecycle.md), [Chapter 3](../01-policy/ch03-security-guardrails-and-client-data.md), [Chapter 4](../01-policy/ch04-autonomy-oversight-and-permissions.md) |

---

## Part A — Agent charter

```markdown
# Agent charter — <agent-id>

| Field | Value |
|---|---|
| Purpose / problem solved | |
| Why an agent (not a script)? | |
| Business owner / technical owner | |
| Users and workflows (phases, tasks) | |
| Out of scope | |
| Risk tier / maximum autonomy (L0–L4) | |
| Environments | sandbox / staging / production (read-only) |
| Data it may read (data classes) | |
| Side effects it may create | |
| Stop and hand over to a person when | |
| Success metrics | |
| Known failure modes | |
| Review or expiry date | |
```

## Part B — Register entry (one row in `docs/agents/register.md`)

| Agent ID | Version | Status | Owner | Model + version | Instructions file + version | Tools | Context sources | Max autonomy | Environments | Last recertified |
|---|---|---|---|---|---|---|---|---|---|---|
| | | proposed / active / suspended / retired | | | | | | | | |

## Part C — Permission configuration

```yaml
agent: <agent-id>
version: <x.y>
model: <provider/model@version>      # pinned
instructions: AGENTS.md@<version>    # integrity-checked before runs
autonomy_max: L2
oversight_default: HOTL
tools:
  allow: [read_repo, edit_files, run_tests, create_branch, open_pull_request]
  deny: [merge, deploy_production, change_permissions, edit_audit_log, disable_checks]
environments: [sandbox]
network_egress: [git-host, model-gateway]
data_classes_allowed: [public, internal]   # add client_confidential only with client consent
secrets: references only                 # never values
limits:
  budget_usd_per_run: 5
  max_iterations: 30
  max_minutes: 60
  loop_detection: 3 identical tool calls
delegation:
  max_depth: 1
  sub_agents_inherit_at_most_parent_rights: true
kill_switch_owner: <name>
```

## Part D — Approval

| Agent type | Approved by | Name | Date |
|---|---|---|---|
| L0 (reads internal documents only) | Person A + technical owner | | |
| L1–L2 (sandbox, pull requests) | Technical owner + Person B | | |
| L3+ (shared or production systems) | Leadership + security owner | | |

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
