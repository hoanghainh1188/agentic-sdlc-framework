#!/usr/bin/env python3
"""
Create GitHub milestones, labels and issues from design/D-08-backlog.csv.

Requirements:
  - GitHub CLI (`gh`) installed and logged in: `gh auth login`
  - Run from the repo root.

Usage:
  python3 scripts/create-issues.py --repo <owner>/agentic-sdlc-framework --dry-run
  python3 scripts/create-issues.py --repo <owner>/agentic-sdlc-framework
  python3 scripts/create-issues.py --repo <owner>/agentic-sdlc-framework --only A01,A02

Idempotent: skips issues whose title already exists.
"""
import argparse
import csv
import json
import subprocess
import sys

CSV_PATH = "design/D-08-backlog.csv"
MILESTONES = {
    "M-A": "Foundation: infrastructure, security, audit",
    "M-B": "Intent + G1–G3",
    "M-0": "Sample pilot repo (separate repo)",
    "M-C": "Run + G4–G6",
    "M-D": "G7–G8 + evidence + cost",
}
LABELS = {
    "size:S": "c2e0c6",
    "size:M": "fef2c0",
    "size:L": "f9d0c4",
    "backlog-mvp": "0e8a16",
    "repo:pilot": "d4c5f9",
    "handbook-dependent": "5319e7",
}
# Tasks implementing rules from handbook chapters not yet approved (may need rework later)
HANDBOOK_DEPENDENT = {"B01", "B07", "B11", "B12", "C06", "C07", "C10", "C11", "E01", "E02", "E03", "E05"}


def gh(args, dry_run=False, capture=True):
    cmd = ["gh"] + args
    if dry_run:
        print("DRY-RUN:", " ".join(cmd))
        return ""
    res = subprocess.run(cmd, capture_output=capture, text=True)
    if res.returncode != 0:
        print(res.stderr, file=sys.stderr)
        raise SystemExit(f"gh failed: {' '.join(cmd)}")
    return res.stdout


def ensure_milestones(repo, dry_run):
    existing = set()
    if not dry_run:
        out = gh(["api", f"repos/{repo}/milestones?state=all&per_page=100"])
        existing = {m["title"] for m in json.loads(out)}
    for code, desc in MILESTONES.items():
        if code not in existing:
            gh(["api", f"repos/{repo}/milestones", "-f", f"title={code}",
                "-f", f"description={desc}"], dry_run)


def ensure_labels(repo, dry_run):
    for name, color in LABELS.items():
        gh(["label", "create", name, "--repo", repo, "--color", color, "--force"], dry_run)


def existing_titles(repo, dry_run):
    if dry_run:
        return set()
    out = gh(["issue", "list", "--repo", repo, "--state", "all", "--limit", "500",
              "--json", "title"])
    return {i["title"] for i in json.loads(out)}


def build_body(row):
    acs = [a.strip() for a in row["acceptance_criteria"].split(" | ") if a.strip()]
    lines = [
        f"**Task:** {row['id']} · **Milestone:** {row['milestone']} · **Size:** {row['size']}",
        f"**Depends on:** {row['depends_on'].replace(';', ', ') or '—'}",
        f"**Requirements:** {row['requirements']}",
        f"**Code area:** {row['area']}",
        "",
        "### Acceptance criteria",
    ]
    lines += [f"- [ ] AC{i}: {a}" for i, a in enumerate(acs, 1)]
    if row.get("note"):
        lines += ["", f"> Note: {row['note']}"]
    lines += ["", f"Source: `design/D-08-mvp-backlog.md` (task {row['id']}). Follow CLAUDE.md workflow."]
    return "\n".join(lines)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True, help="owner/name")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--only", default="", help="comma-separated task IDs")
    a = p.parse_args()
    only = {x.strip() for x in a.only.split(",") if x.strip()}

    ensure_milestones(a.repo, a.dry_run)
    ensure_labels(a.repo, a.dry_run)
    have = existing_titles(a.repo, a.dry_run)

    with open(CSV_PATH, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    for row in rows:
        if only and row["id"] not in only:
            continue
        title = f"[{row['id']}] {row['title']}"
        if title in have:
            print("skip (exists):", title)
            continue
        labels = ["backlog-mvp", f"size:{row['size']}"]
        if row["milestone"] == "M-0":
            labels.append("repo:pilot")
        if row["id"] in HANDBOOK_DEPENDENT:
            labels.append("handbook-dependent")
        args = ["issue", "create", "--repo", a.repo, "--title", title,
                "--body", build_body(row), "--milestone", row["milestone"]]
        for lb in labels:
            args += ["--label", lb]
        gh(args, a.dry_run)
        print("created:", title)


if __name__ == "__main__":
    main()
