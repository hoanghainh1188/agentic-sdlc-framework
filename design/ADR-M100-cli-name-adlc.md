# ADR-M100. The CLI's name: `@hoanghainh/governed-adlc` and the command `adlc`

| Item | Value |
|---|---|
| Status | **Accepted** |
| Date | 2026-10-29 |
| Decided by | Harry (QUESTIONS #631, 2026-10-29) |
| Related | ADR-M99 (the repository's name); ADR-M72 (the CLI on npm); ADR-M94 (the release on the tag); ADR-M84 (rules as checks); `RELEASING.md`; rules R014, R040, R132 |

## 1. Context

ADR-M99 renamed the repository to `governed-adlc-fw` and kept the npm package `agentic-sdlc-cli` and the command `sdlc`. Harry now wants the CLI to match the new name too: the package name and the command a user types.

Three things make a rename more than a search and replace:

- **Users already have the CLI.** People installed `agentic-sdlc-cli` and type `sdlc`; scripts call it. A rename must not break them in one release.
- **Users are logged in.** `sdlc login` saves the login in `credentials.json` in `$XDG_CONFIG_HOME/sdlc` (or `~/.config/sdlc`). Nobody should have to log in again.
- **npm's trusted publisher needs a package that exists** (ADR-M72 §2.3, "The first version"). A new package name repeats that first step.

## 2. Decision

1. **Names.** The npm package becomes **`@hoanghainh/governed-adlc`** (a scoped, public package). The command becomes **`adlc`**. The root script `pnpm sdlc …` becomes **`pnpm adlc …`**.
2. **One release with both commands.** From v0.9.0 the package installs two binaries, `adlc` and `sdlc`, from the same file. `sdlc` first writes one short note to stderr through the message catalog ("`sdlc` is now `adlc`", rule R014), then runs exactly as `adlc`, with the same arguments and exit code. `pnpm sdlc …` stays as an alias of `pnpm adlc …` for the same release. **v0.10.0 removes both aliases.**
3. **Existing logins keep working.** `adlc` saves its login in `$XDG_CONFIG_HOME/adlc` (or `~/.config/adlc`), with the same rules as today (absolute paths only, folder mode `0700`, file mode `0600`, no symbolic links). When the new folder has no `credentials.json`, the CLI reads the one in the old folder (`…/sdlc`) with the same checks. The next save writes to the new folder only. `adlc logout` removes the login from both folders, so an old login never comes back after a logout. The CLI never prints or logs the token while it does this; a message names the folder at most.
4. **Internal names stay.** The `SDLC_*` settings, the services and images `sdlc-api`, `sdlc-worker`, `sdlc-runner`, the database names and roles, the message keys (`cli.…`) and the package scope `@sdlc/` inside the monorepo do not change. Only the names a user types or installs change.
5. **The guard hook.** `platform/tools/claude-hooks/guard-bash.mjs` refuses `pnpm adlc ops bootstrap|token …` and the `adlc` binary's same commands exactly as it refuses the `sdlc` forms today, and it keeps refusing the `sdlc` forms (rule R132: the hook is never weakened). `design/RULES.md` and `CLAUDE.md` name both forms.
6. **npm, in this order.** All steps are Harry's (rule R040; Claude never publishes):
   1. Harry publishes the first version of `@hoanghainh/governed-adlc` (v0.9.0) **by hand**, from the checked tarball that the release run keeps as an artifact (ADR-M72 §2.3, "The first version"; 2FA, no provenance for that version).
   2. Harry adds the trusted publisher on npmjs.com with **"Allow npm publish" ticked**: user `hoanghainh1188`, repository `governed-adlc-fw`, workflow `npm-publish.yml`, environment `npm`. (During v0.8.0, the publish failed until this box was ticked on the new publisher entry.) Then "Require two-factor authentication and disallow tokens".
   3. Harry runs `npm deprecate agentic-sdlc-cli "moved to @hoanghainh/governed-adlc"`.
   4. Every later version goes through `npm-publish.yml`, as today.
   `npm-publish.yml`, `platform/apps/cli/npm/package.template.json`, the CLI pack check, `RELEASING.md` and `platform/GETTING-STARTED.md` ("Publishing the CLI on npm") use the new name.
7. **Release.** The rename ships in **v0.9.0**, a minor release. Its Upgrade notes tell users to run `npm install -g @hoanghainh/governed-adlc@0.9.0`, that `sdlc` keeps working until v0.10.0, and that the existing login is used without a new `login`.
8. **Handbook.** The platform usage parts that Claude owns (Ch.13–16 and Ch.18–20 usage sections, runbooks such as T11) use `adlc`. The policy chapters, `handbook/00-introduction` and template T13 are not edited in Claude Code (rule R094); the pull request lists their lines that still say `sdlc`, for Harry.
9. **History stays as written.** Accepted ADRs, `design/QUESTIONS.md` and CHANGELOG sections of past releases keep `sdlc` and `agentic-sdlc-cli`, because they describe what was true then. This ADR replaces the package name in ADR-M72 and ADR-M99 §2.5, and the command name in current documents and code, from v0.9.0 on.

## 3. Consequences

- A user upgrades with one `npm install -g`; `sdlc` and the saved login keep working for one minor release. `npm uninstall -g agentic-sdlc-cli` is needed once, if both packages are installed, because both provide `sdlc` (the Upgrade notes say this).
- Scripts that call `sdlc` see one note on stderr per call until they move to `adlc`. Standard output and exit codes do not change.
- The v0.9.0 release has one manual npm step again (step 6.1), like v0.1.1.
- v0.10.0 needs a small change task: remove the `sdlc` binary, the `pnpm sdlc` alias and the note. [Proposal] Keep reading the old login folder (it costs nothing and protects users who skip v0.9.0); that task decides.
- The command appears in about 160 files and in 112 messages of the catalog; the rename is one pull request with the code, the catalog, the tests and the documents.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-29 | Claude, approved by Harry | The package `@hoanghainh/governed-adlc`, the command `adlc`, the one-release aliases, the login folder, the npm order (QUESTIONS #631) |
| 1.1 | 2026-10-30 | Claude, approved by Harry | §3: the change task for v0.10.0 is done as planned: the `sdlc` binary, `pnpm sdlc` and the note `cli.renamed` are removed; the old login folder `…/sdlc` is still read (the proposal of §3, accepted by Harry, 2026-10-30); the Bash hook still refuses `pnpm sdlc ops bootstrap\|token` |
