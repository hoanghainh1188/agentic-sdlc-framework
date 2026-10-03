#!/usr/bin/env python3
"""Render the Mermaid diagrams to SVG, and check that the committed SVG files match their sources.

  python3 scripts/diagrams.py render [name ...]   # pnpm diagrams:render — needs Docker
  python3 scripts/diagrams.py check               # pnpm diagrams:check — CI (scan job)

render: diagrams/src/<name>.mmd -> diagrams/svg/<name>.svg with the pinned mermaid-cli image. The
first line of each SVG is `<!-- source-sha256: <hex> -->`, the SHA-256 of the .mmd file's bytes.

check (no Docker, no network):
  - every .mmd has an SVG and every SVG has a source;
  - the first line of each SVG holds the SHA-256 of its .mmd;
  - each SVG is well-formed XML with an <svg> root element.
The check does not compare the drawing itself: the layout differs between Chromium builds (for
example arm64 and amd64), so a byte comparison would make CI flaky. It also cannot prove that the
SVG was rendered by the tool; a hand edit that keeps the stamp would pass (diagrams/README.md).
"""

import hashlib
import os
import re
import subprocess
import sys
import tempfile
import xml.parsers.expat
from pathlib import Path

# Pinned by version and by digest (multi-arch index). Update both together, by hand.
MERMAID_CLI_IMAGE = (
    "minlag/mermaid-cli:11.17.0"
    "@sha256:a6fb0574dded4086888b5e38476899c9aff8963196f689f11a0f8fceee588ce1"
)

# DIAGRAMS_ROOT: another repository root, for the tests (platform/tests/workspace/diagrams.test.ts).
ROOT = Path(os.environ.get("DIAGRAMS_ROOT") or Path(__file__).resolve().parent.parent)
SRC = ROOT / "diagrams" / "src"
SVG = ROOT / "diagrams" / "svg"
STAMP = re.compile(r"<!-- source-sha256: ([0-9a-f]{64}) -->")


def source_sha256(mmd: Path) -> str:
    return hashlib.sha256(mmd.read_bytes()).hexdigest()


def stamp_line(mmd: Path) -> str:
    return f"<!-- source-sha256: {source_sha256(mmd)} -->"


def render(names: list[str]) -> int:
    sources = sorted(SRC.glob("*.mmd"))
    if names:
        wanted = set(names)
        unknown = wanted - {s.stem for s in sources}
        if unknown:
            print(f"no source for: {', '.join(sorted(unknown))}", file=sys.stderr)
            return 2
        sources = [s for s in sources if s.stem in wanted]
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        os.chmod(out, 0o777)  # the container user writes here
        for mmd in sources:
            subprocess.run(
                [
                    "docker", "run", "--rm", "--network", "none",
                    "-v", f"{SRC}:/data/src:ro", "-v", f"{out}:/data/out",
                    MERMAID_CLI_IMAGE,
                    "-i", f"/data/src/{mmd.name}", "-o", f"/data/out/{mmd.stem}.svg", "-b", "white",
                ],
                check=True,
            )
            body = (out / f"{mmd.stem}.svg").read_text(encoding="utf-8")
            (SVG / f"{mmd.stem}.svg").write_text(f"{stamp_line(mmd)}\n{body}", encoding="utf-8")
            print(f"rendered diagrams/svg/{mmd.stem}.svg")
    return 0


def well_formed_svg(path: Path) -> str | None:
    """Return None when the file is well-formed XML with an <svg> root, else the reason."""
    root: list[str] = []
    parser = xml.parsers.expat.ParserCreate(namespace_separator=" ")
    parser.StartElementHandler = lambda name, _attrs: root.append(name) if not root else None
    try:
        parser.Parse(path.read_bytes(), True)
    except xml.parsers.expat.ExpatError as err:
        return f"not well-formed XML ({err})"
    if not root or root[0].split(" ")[-1] != "svg":
        return "the root element is not <svg>"
    return None


def check() -> int:
    sources = {p.stem: p for p in SRC.glob("*.mmd")}
    svgs = {p.stem: p for p in SVG.glob("*.svg")}
    problems: list[str] = []
    for name in sorted(sources.keys() - svgs.keys()):
        problems.append(f"diagrams/src/{name}.mmd has no SVG")
    for name in sorted(svgs.keys() - sources.keys()):
        problems.append(f"diagrams/svg/{name}.svg has no source")
    for name in sorted(sources.keys() & svgs.keys()):
        svg = svgs[name]
        first = svg.read_text(encoding="utf-8").split("\n", 1)[0]
        match = STAMP.fullmatch(first)
        if not match:
            problems.append(f"diagrams/svg/{name}.svg has no source-sha256 stamp on its first line")
        elif match.group(1) != source_sha256(sources[name]):
            problems.append(f"diagrams/svg/{name}.svg is stale: diagrams/src/{name}.mmd changed")
        reason = well_formed_svg(svg)
        if reason:
            problems.append(f"diagrams/svg/{name}.svg: {reason}")
    if problems:
        for problem in problems:
            print(f"::error::{problem}" if os.environ.get("GITHUB_ACTIONS") else problem, file=sys.stderr)
        print("Fix: run `pnpm diagrams:render` and commit diagrams/svg.", file=sys.stderr)
        return 1
    print(f"{len(sources)} diagram(s): every SVG matches its source.")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) >= 1 and argv[0] == "render":
        return render(argv[1:])
    if argv == ["check"]:
        return check()
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
