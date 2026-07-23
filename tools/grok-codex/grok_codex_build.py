"""Dependency-free PEP 517 backend for the small pure-Python command package."""

from __future__ import annotations

import base64
import hashlib
from pathlib import Path
import tarfile
import tempfile
from typing import Any
import zipfile


NAME = "grok_codex"
VERSION = "0.1.0"
DIST_INFO = f"{NAME}-{VERSION}.dist-info"
WHEEL_NAME = f"{NAME}-{VERSION}-py3-none-any.whl"
ROOT = Path(__file__).parent
README = (ROOT / "README.md").read_text(encoding="utf-8")

METADATA = f"""Metadata-Version: 2.1
Name: grok-codex
Version: 0.1.0
Summary: Use Grok Build with ChatGPT Codex models through CLIProxyAPI
Requires-Python: >=3.11
License: MIT
Keywords: codex,grok-build,oauth,cli,responses-api
Classifier: Development Status :: 3 - Alpha
Classifier: Environment :: Console
Classifier: License :: OSI Approved :: MIT License
Classifier: Operating System :: MacOS
Classifier: Operating System :: POSIX :: Linux
Classifier: Programming Language :: Python :: 3
Classifier: Programming Language :: Python :: 3 :: Only
Classifier: Topic :: Software Development :: Libraries :: Application Frameworks
Description-Content-Type: text/markdown

{README}
"""

WHEEL = """Wheel-Version: 1.0
Generator: grok-codex-build
Root-Is-Purelib: true
Tag: py3-none-any
"""

ENTRY_POINTS = """[console_scripts]
grok-codex = grok_codex.cli:main
"""


def get_requires_for_build_wheel(config_settings: dict[str, Any] | None = None) -> list[str]:
    return []


def get_requires_for_build_sdist(config_settings: dict[str, Any] | None = None) -> list[str]:
    return []


def prepare_metadata_for_build_wheel(
    metadata_directory: str,
    config_settings: dict[str, Any] | None = None,
) -> str:
    target = Path(metadata_directory) / DIST_INFO
    target.mkdir(parents=True, exist_ok=True)
    (target / "METADATA").write_text(METADATA)
    (target / "WHEEL").write_text(WHEEL)
    (target / "entry_points.txt").write_text(ENTRY_POINTS)
    return DIST_INFO


def build_wheel(
    wheel_directory: str,
    config_settings: dict[str, Any] | None = None,
    metadata_directory: str | None = None,
) -> str:
    files: dict[str, bytes] = {}
    for source in sorted((ROOT / "src" / "grok_codex").glob("*.py")):
        files[f"grok_codex/{source.name}"] = source.read_bytes()
    files[f"{DIST_INFO}/METADATA"] = METADATA.encode()
    files[f"{DIST_INFO}/WHEEL"] = WHEEL.encode()
    files[f"{DIST_INFO}/entry_points.txt"] = ENTRY_POINTS.encode()
    for document in ("LICENSE", "README.md", "DISCLAIMER.md", "THIRD_PARTY_NOTICES.md"):
        files[f"{DIST_INFO}/{document}"] = (ROOT / document).read_bytes()

    records = []
    for name, content in files.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
        records.append(f"{name},sha256={digest},{len(content)}")
    record_name = f"{DIST_INFO}/RECORD"
    records.append(f"{record_name},,")
    files[record_name] = ("\n".join(records) + "\n").encode()

    target = Path(wheel_directory) / WHEEL_NAME
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return WHEEL_NAME


def build_sdist(
    sdist_directory: str,
    config_settings: dict[str, Any] | None = None,
) -> str:
    filename = f"grok_codex-{VERSION}.tar.gz"
    target = Path(sdist_directory) / filename
    root = ROOT
    sources = [
        root / "pyproject.toml",
        root / "README.md",
        root / "DISCLAIMER.md",
        root / "LICENSE",
        root / "THIRD_PARTY_NOTICES.md",
        root / "grok_codex_build.py",
    ]
    sources.extend(sorted((root / "src" / "grok_codex").glob("*.py")))
    sources.extend(sorted((root / "tests").glob("*.py")))
    with tempfile.TemporaryDirectory() as temporary:
        package_root = Path(temporary) / f"grok_codex-{VERSION}"
        for source in sources:
            relative = source.relative_to(root)
            destination = package_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(source.read_bytes())
        with tarfile.open(target, "w:gz") as archive:
            archive.add(package_root, arcname=package_root.name)
    return filename
