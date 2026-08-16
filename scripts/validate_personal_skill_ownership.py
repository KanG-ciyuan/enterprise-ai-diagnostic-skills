#!/usr/bin/env python3
"""Guard the installable Skill packages against attribution drift."""

from pathlib import Path
import json
import re


PACKAGE_DIRS = (
    "enterprise-interview-preparation",
    "enterprise-workflow-mapping",
    "enterprise-material-analysis",
    "enterprise-ai-process-diagnosis",
    "enterprise-ai-diagnostic-orchestrator",
)
OWNER = "Kang Jiaxin"
FORBIDDEN_MARKERS = (
    "qiaomu",
    "乔木",
    "向阳",
    "joeseesun",
    "vista8",
    "skills.sh",
    "skillsmp",
    "github.com/",
)
TEXT_SUFFIXES = {".md", ".json", ".yaml", ".yml", ".py", ".txt", ".csv"}
URL_PATTERN = re.compile(r"https?://[^\s\"')>]+")


def validate(root: Path) -> list[str]:
    errors = []
    for package_name in PACKAGE_DIRS:
        package = root / package_name
        if not package.is_dir():
            errors.append(f"PACKAGE_MISSING:{package_name}")
            continue
        for path in package.rglob("*"):
            if not path.is_file():
                continue
            if "__pycache__" in path.parts:
                continue
            if path.name.upper().startswith(("LICENSE", "COPYING")):
                text = path.read_text(encoding="utf-8", errors="replace")
                if OWNER.lower() not in text.lower():
                    errors.append(f"LICENSE_OWNER_MISSING:{path.relative_to(root)}")
                continue
            if path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            text = path.read_text(encoding="utf-8", errors="replace").lower()
            for marker in FORBIDDEN_MARKERS:
                if marker.lower() in text:
                    errors.append(f"FORBIDDEN_MARKER:{path.relative_to(root)}:{marker}")
            if path.name in {"SKILL.md", "manifest.json", "skill-ir.json"}:
                if path.name == "SKILL.md" and "owner: kang jiaxin" not in text:
                    errors.append(f"OWNER_MISSING:{path.relative_to(root)}")
                if path.name in {"manifest.json", "skill-ir.json"} and '"owner": "kang jiaxin"' not in text:
                    errors.append(f"OWNER_MISSING:{path.relative_to(root)}")
            for url in URL_PATTERN.findall(text):
                if "json-schema.org/" not in url:
                    errors.append(f"EXTERNAL_URL:{path.relative_to(root)}:{url}")
            if path.suffix.lower() == ".json":
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    continue
                if isinstance(payload, dict) and payload.get("upstream_inspiration") not in (None, ""):
                    errors.append(f"UPSTREAM_INSPIRATION_PRESENT:{path.relative_to(root)}")
    return sorted(set(errors))


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    errors = validate(root)
    if errors:
        print("\n".join(errors))
        return 1
    print("personal_skill_ownership_valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
