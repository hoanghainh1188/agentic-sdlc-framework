#!/usr/bin/env python3
"""Build a clean snapshot of this repository for the public repository (option B1).

The private repository stays the place of work; the public repository receives releases made by
this script. It never pushes anything: it writes a folder (and, with --git, a fresh Git repository
with one commit) for the owner to check and push.

What it does:
  1. Exports the files of a commit (default HEAD) with `git archive`: no history, no untracked files.
  2. Replaces `_review/` (internal notes) with a short README (scripts/public/overlay/).
  3. CLAUDE.md: removes the status banner and the "Current constraints" section, and the lines that
     name the internal reference documents or `_review/`.
  4. CONTRIBUTING.md: points at the public repository; removes the private-repository rows.
  5. CHANGELOG.md: removes the lines that name the internal reference documents.
  6. Refuses the result when a file still names an internal reference document or holds a
     "TO BE ADDED" marker, and when Gitleaks finds anything.

Usage:
  python3 scripts/export-public.py --out <empty folder> --public-repo <owner/name> [--ref <commit>] [--git]
"""
from __future__ import annotations

import argparse
import io
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OVERLAY = ROOT / "scripts" / "public" / "overlay"
GITLEAKS_IMAGE = "zricethezav/gitleaks:v8.30.1"

# Text that must never reach the public repository.
FORBIDDEN = [
    re.compile(r"Bản chất"),
    re.compile(r"Digital[_ ]Foundry", re.IGNORECASE),
    re.compile(r"TO BE ADDED"),
]
# Text reported (not refused): citations of an internal draft readers cannot open.
WARN = [re.compile(r"[Dd]raft v1\.0")]


class ExportError(Exception):
    pass


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kw)


def export_tree(ref: str, out: Path) -> None:
    data = run(["git", "-C", str(ROOT), "archive", "--format=tar", ref], capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        tar.extractall(out, filter="data")


def replace_review(out: Path) -> None:
    shutil.rmtree(out / "_review", ignore_errors=True)
    shutil.copytree(OVERLAY, out, dirs_exist_ok=True)


def drop_section(text: str, heading: str) -> str:
    start = text.find(f"\n{heading}\n")
    if start < 0:
        raise ExportError(f"CLAUDE.md: section '{heading}' not found")
    nxt = text.find("\n## ", start + 1)
    return text[:start] + (text[nxt:] if nxt >= 0 else "\n")


def edit_claude_md(out: Path) -> None:
    p = out / "CLAUDE.md"
    text = p.read_text(encoding="utf-8")
    first = text.find("\n## ")
    if first < 0:
        raise ExportError("CLAUDE.md: no section found")
    title = text.split("\n", 1)[0]
    text = title + "\n" + text[first:]  # the status banner sits between the title and the first section
    text = drop_section(text, "## Current constraints")
    lines = []
    for line in text.split("\n"):
        if "internal reference documents" in line:
            lines.append("- The handbook states its rules directly; it cites only external sources and other repo documents.")
        elif "`_review/` —" in line:
            continue
        else:
            lines.append(line)
    p.write_text("\n".join(lines), encoding="utf-8")


def edit_contributing(out: Path, public_repo: str) -> None:
    p = out / "CONTRIBUTING.md"
    lines = p.read_text(encoding="utf-8").split("\n")
    found = False
    result = []
    for line in lines:
        if line.startswith("| Location |"):
            result.append(
                f"| Location | `github.com/{public_repo}`, public. Releases come from the maintainers' working "
                "repository; pull requests here are welcome and are carried over by a maintainer |"
            )
            found = True
        elif line.startswith("| Plan |") or line.startswith("| Historical notes |"):
            continue
        else:
            result.append(line)
    if not found:
        raise ExportError("CONTRIBUTING.md: the 'Location' row was not found")
    p.write_text("\n".join(result), encoding="utf-8")


def edit_changelog(out: Path) -> None:
    p = out / "CHANGELOG.md"
    lines = p.read_text(encoding="utf-8").split("\n")
    p.write_text("\n".join(l for l in lines if not any(r.search(l) for r in FORBIDDEN)), encoding="utf-8")


def scan_text(out: Path) -> list[str]:
    problems, warnings = [], []
    for f in sorted(out.rglob("*")):
        if not f.is_file():
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        rel = f.relative_to(out)
        if rel == Path("scripts/export-public.py"):
            continue  # this script names the patterns it refuses
        for r in FORBIDDEN:
            if r.search(text):
                problems.append(f"{rel}: contains /{r.pattern}/")
        for r in WARN:
            n = len(r.findall(text))
            if n:
                warnings.append(f"{rel}: {n}× /{r.pattern}/")
    for w in warnings:
        print(f"warning: {w}")
    return problems


def gitleaks(out: Path) -> None:
    if shutil.which("docker") is None:
        raise ExportError("Docker is needed for the Gitleaks scan of the snapshot")
    # Scan "." from inside the folder: the repository's approved allowlists match relative paths.
    cfg = ["--config", ".gitleaks.toml"] if (out / ".gitleaks.toml").exists() else []
    res = subprocess.run(
        ["docker", "run", "--rm", "-v", f"{out}:/scan", "-w", "/scan", GITLEAKS_IMAGE, "dir", *cfg, "--redact", "."],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        tail = "\n".join((res.stdout + res.stderr).strip().splitlines()[-5:])
        raise ExportError(f"Gitleaks found something in the snapshot (values redacted):\n{tail}")


def make_git(out: Path) -> None:
    run(["git", "-C", str(out), "init", "-q", "-b", "main"])
    run(["git", "-C", str(out), "add", "-A"])
    run(["git", "-C", str(out), "commit", "-q", "-m", "Public release of the Agentic SDLC Framework"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, type=Path, help="an empty or missing folder outside this repository")
    ap.add_argument("--public-repo", required=True, help="owner/name of the public repository")
    ap.add_argument("--ref", default="HEAD", help="the commit to export (default HEAD)")
    ap.add_argument("--git", action="store_true", help="also create a Git repository with one commit")
    args = ap.parse_args()

    out = args.out.resolve()
    if not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+", args.public_repo):
        print("error: --public-repo must look like owner/name", file=sys.stderr)
        return 2
    if out == ROOT or ROOT in out.parents:
        print("error: --out must be outside this repository", file=sys.stderr)
        return 2
    if out.exists() and any(out.iterdir()):
        print(f"error: {out} is not empty", file=sys.stderr)
        return 2
    out.mkdir(parents=True, exist_ok=True)

    try:
        export_tree(args.ref, out)
        replace_review(out)
        edit_claude_md(out)
        edit_contributing(out, args.public_repo)
        edit_changelog(out)
        problems = scan_text(out)
        if problems:
            raise ExportError("internal content left in the snapshot:\n  " + "\n  ".join(problems))
        gitleaks(out)
        if args.git:
            make_git(out)
    except (ExportError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        print(f"The folder {out} is incomplete; delete it before trying again.", file=sys.stderr)
        return 1
    print(f"Snapshot ready in {out}. Nothing was pushed: check it, then push it to {args.public_repo} yourself.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
