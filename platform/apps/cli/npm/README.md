# agentic-sdlc-cli

The `sdlc` command of the [Agentic SDLC Framework](https://github.com/hoanghainh1188/agentic-sdlc-framework): create intents, decide gates G1–G8, handle escalations, read evidence and cost, all through your platform's API.

```bash
npm install -g agentic-sdlc-cli
sdlc --version
sdlc login --api-url https://<your platform>
sdlc whoami
```

- Needs Node.js 24.
- You need an account and an API token on a running platform. Ask your tenant admin; read the [user guide](https://github.com/hoanghainh1188/agentic-sdlc-framework/blob/main/platform/USER-GUIDE.md).
- The operator commands (`sdlc ops …`) work only on the platform server, with `SDLC_DB_URL`.
- Every release is published from a tag of the repository by GitHub Actions, with npm provenance.

MIT licence. The bundled third-party packages and their licences are listed in `THIRD-PARTY-NOTICES`.
