# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**
(GitHub private vulnerability reporting). Include:

- what is affected (component, file, version or commit);
- how to reproduce it, or a proof of concept;
- the impact you expect (for example a secret exposed, a gate bypassed, data of one tenant readable by another).

Never include real secrets, real client data or personal data in a report.

## What happens next

- We confirm that we received the report within 5 working days.
- We assess it, agree on a fix and a disclosure date with you, and credit you in the release notes and the advisory unless you prefer not.
- Until the fix is released, please keep the details private.

## Scope

In scope: the platform in `platform/` (the API, the worker, the runner, the CLI, the dashboard, the adapters, the deployment files) and the security rules the handbook states.

Especially important for this project:

- an agent or a person bypassing a human gate (G1–G8), or the producer of a change approving it;
- a sandbox reaching anything other than its allowed egress (the model gateway, the package proxy);
- a secret leaving OpenBao, or appearing in a log, an event, a table or the Temporal history;
- one tenant reading or changing another tenant's data;
- the append-only audit log, gate decisions or cost records being changed without detection.

Out of scope: problems in the reused components themselves (report them to their projects), and deployments that do not follow `platform/deploy/README.md`.

## Supported versions

Only **the latest release** is supported ([RELEASING.md](RELEASING.md)): a fix, also a security fix, comes in a new release, and older releases get no patches. After the fix is released, the advisory is published as a GitHub Security Advisory.
