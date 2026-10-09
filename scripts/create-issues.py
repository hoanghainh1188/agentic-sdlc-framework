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
  python3 scripts/create-issues.py --repo <owner>/agentic-sdlc-framework --update --dry-run
  python3 scripts/create-issues.py --repo <owner>/agentic-sdlc-framework --update

Idempotent: skips issues that already exist (matched by the "[ID] " title prefix).
--update also brings the OPEN issues of existing tasks in line with the CSV after
D-08 changes: title, body and size label (stale size labels removed), and the
handbook-dependent label. Closed issues are never changed.
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
    "Pre-M-E": "Before the trial M-E: spec tools and document knowledge (QUESTIONS #285)",
    "M-E": "The trial, run by the community (QUESTIONS #340)",
    "MVP+1": "Started early: read-only dashboard (QUESTIONS #255)",
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


def existing_issues(repo):
    """Issues by task ID (the "[ID] " title prefix). Read even in dry-run mode."""
    out = gh(["issue", "list", "--repo", repo, "--state", "all", "--limit", "500",
              "--json", "number,title,body,state,labels"])
    found = {}
    for issue in json.loads(out):
        title = issue["title"]
        if title.startswith("[") and "] " in title:
            found[title[1:title.index("] ")]] = issue
    return found


def labels_for(row):
    labels = ["backlog-mvp", f"size:{row['size']}"]
    if row["milestone"] == "M-0":
        labels.append("repo:pilot")
    if row["id"] in HANDBOOK_DEPENDENT:
        labels.append("handbook-dependent")
    return labels


def update_issue(repo, issue, row, dry_run):
    """Brings an open issue in line with the CSV row. Returns True when it changed."""
    title = f"[{row['id']}] {row['title']}"
    body = build_body(row)
    have = {lb["name"] for lb in issue["labels"]}
    want = set(labels_for(row))
    args = ["issue", "edit", str(issue["number"]), "--repo", repo]
    if issue["title"] != title:
        args += ["--title", title]
    if issue["body"].strip() != body.strip():
        args += ["--body", body]
    for lb in sorted(want - have):
        args += ["--add-label", lb]
    for lb in sorted(lb for lb in have - want if lb.startswith("size:")):
        args += ["--remove-label", lb]
    if len(args) == 5:
        return False
    gh(args, dry_run)
    return True


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
    p.add_argument("--update", action="store_true",
                   help="also update open issues of existing tasks from the CSV")
    a = p.parse_args()
    only = {x.strip() for x in a.only.split(",") if x.strip()}

    ensure_milestones(a.repo, a.dry_run)
    ensure_labels(a.repo, a.dry_run)
    have = existing_issues(a.repo)

    with open(CSV_PATH, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    for row in rows:
        if only and row["id"] not in only:
            continue
        title = f"[{row['id']}] {row['title']}"
        issue = have.get(row["id"])
        if issue:
            if not a.update:
                print("skip (exists):", title)
            elif issue["state"] != "OPEN":
                print("skip (closed):", title)
            elif update_issue(a.repo, issue, row, a.dry_run):
                print("updated:", title)
            else:
                print("up to date:", title)
            continue
        labels = labels_for(row)
        args = ["issue", "create", "--repo", a.repo, "--title", title,
                "--body", build_body(row), "--milestone", row["milestone"]]
        for lb in labels:
            args += ["--label", lb]
        gh(args, a.dry_run)
        print("created:", title)


if __name__ == "__main__":
    main()
