# Spike X09: other Git hosts (GitLab.com, Bitbucket Cloud, Backlog)

This is a **spike**, not product code. It may be thrown away. The result is
[`design/ADR-M70-other-git-hosts.md`](../../../design/ADR-M70-other-git-hosts.md).
Nothing in `platform/apps` or `platform/packages` may import it.

The spike is desk research only (repository owner, 2026-10-21): the cloud versions of each host,
compared with their official API documentation. No account, token or live call was used.

| File | Purpose |
|---|---|
| `matrix.json` | The 22 methods of `GitHostAdapter` (`platform/packages/contracts/src/git-host.ts`) × the three hosts: `works`, `partial`, `git` (only with git on a clone) or `missing`; the plan tiers that matter; the effort in days. Codes and numbers only |

How the facts were read: this session's network proxy blocked the documentation sites, so the
research used the text of official pages as quoted by a search tool, and, for Backlog, the source
of Nulab's own client libraries. ADR-M70 §4 lists what must be checked on a live account before an
adapter is built (task X10).
