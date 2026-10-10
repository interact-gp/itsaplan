"""Create a secret-free working-tree snapshot for an EC2 application update."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
args = parser.parse_args()
output = args.output.resolve()
if output.exists():
    raise SystemExit("Refusing to overwrite an existing release directory")

paths = subprocess.check_output(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root
).decode().split("\0")
excluded = {
    ".local", ".codex", ".claude", ".cursor", ".kiro", ".workspace",
    ".agents", ".git", "__pycache__",
}
instructions = {"AGENTS.md", "CLAUDE.md", "PROJECT_MEMORY.md"}
files = {}
for name in sorted(set(paths) - {""}):
    path = Path(name)
    source = root / path
    if any(part in excluded for part in path.parts):
        continue
    if (
        path.name.startswith(".env")
        or path.name in instructions
        or path.suffix == ".pyc"
        or not source.exists()
    ):
        continue
    if source.is_symlink() or not source.is_file():
        raise SystemExit(f"Unsupported source entry: {name}")
    files[name] = hashlib.sha256(source.read_bytes()).hexdigest()

fingerprint = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
tag = "v1-" + fingerprint[:16]
source_dir = output / "source"
source_dir.mkdir(parents=True, mode=0o700)
for name in files:
    target = source_dir / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / name, target)
    if hashlib.sha256(target.read_bytes()).hexdigest() != files[name]:
        raise SystemExit("Source changed while packaging; discard this snapshot")

images = {service: f"itsaplan-local/{service}:{tag}" for service in ("api", "web", "worker", "bot")}
manifest = {
    "base_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root).decode().strip(),
    "source_sha256": fingerprint,
    "platform": "linux/amd64",
    "images": images,
    "files": files,
}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
with tarfile.open(output / "source.tar.gz", "w:gz") as archive:
    for name in files:
        archive.add(source_dir / name, arcname=name, recursive=False)
overrides = []
for service, image in images.items():
    override = f"  {service}:\n    image: {image}\n    pull_policy: never\n"
    if service == "api":
        override += (
            "    environment:\n"
            "      BETTER_AUTH_TELEMETRY: 'false'\n"
            "      MASTRA_TELEMETRY_DISABLED: '1'\n"
            "      UPDATE_CHECKS_ENABLED: '0'\n"
            "      MODEL_CATALOG_ENABLED: '0'\n"
        )
    elif service == "worker":
        override += "    environment:\n      TELEMETRY_DISABLED: '1'\n      DO_NOT_TRACK: '1'\n"
    overrides.append(override)
(output / "compose.update.yml").write_text("services:\n" + "".join(overrides))

print(json.dumps({"output": str(output), "source_sha256": fingerprint, "file_count": len(files), "images": images}))
