# Platform

Code of the Agentic SDLC Framework platform. **Not started yet.** Start with [GETTING-STARTED.md](GETTING-STARTED.md).

The MVP is a **modular monolith** (see `design/D-03`, ADR-M01).

```text
platform/
├── apps/        # api (NestJS), worker (Temporal), runner (sandbox), cli
├── packages/    # core, contracts, adapters/*, config
├── deploy/      # docker-compose.yml, OpenBao bootstrap, backups
└── tests/       # integration (scenarios N1–N6, tasks T01–T10 from D-09)
```

Details: `design/D-03` section 11.
