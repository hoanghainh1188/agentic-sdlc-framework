# T11 Runbook: operating OpenBao (unseal, backup, restore)

> Status: **Outline** · Readers: key holders, infrastructure operator
> Written by Claude Code in platform tasks A03 and A10, following `design/D-03` section 10.2. Tested in the recovery drill at milestone M-A.

## Planned sections

1. Purpose and scope
2. Roles: three key holders (names from leadership), infrastructure operator
3. Initialisation (once): 3 key shares, any 2 unseal; printed copies sealed in the company safe
4. Unseal after a server restart
5. Root token: create only when needed, revoke immediately, log every use
6. Daily snapshot backup: where, how, how to check it
7. Restore on a test machine (recovery drill), step by step
8. Changing a key holder: rekey, destroy old envelopes
9. Troubleshooting
10. Operations log template

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | Outline; content written by Claude Code in A03/A10 |
