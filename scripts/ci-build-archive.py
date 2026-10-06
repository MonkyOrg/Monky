import os
import stat
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

UNIX_ZIP_HOST = 3


def restore_mode(entry, filename):
    # extractall drops the Unix modes stored in the archive, so the macOS capture host would
    # lose its execute bit. Keep owner read/write and never grant group/other write or setuid.
    mode = (entry.external_attr >> 16) & 0o777
    if entry.create_system == UNIX_ZIP_HOST and mode and not entry.is_dir():
        os.chmod(filename, (mode & 0o755) | 0o600)


def extract_build(archive, destination):
    destination = Path(destination)
    if destination.exists():
        raise ValueError("Build extraction requires a new directory.")
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if not entries or len(entries) > 100000 or sum(entry.file_size for entry in entries) > 6_000_000_000:
            raise ValueError("Unexpected build archive size.")
        seen = set()
        for entry in entries:
            name = entry.orig_filename
            parts = PurePosixPath(name).parts
            mode = entry.external_attr >> 16
            if (not parts or name.startswith("/") or "\\" in name or ":" in name
                    or any(ord(char) < 32 for char in name) or any(part in ("", ".", "..") for part in name.rstrip("/").split("/"))
                    or any(part.endswith((".", " ")) for part in parts)
                    or any(re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", part, re.IGNORECASE) for part in parts)
                    or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)))):
                raise ValueError("Unsafe build archive member.")
            key = name.rstrip("/").lower()
            if key in seen:
                raise ValueError("Duplicate build archive member.")
            seen.add(key)
        destination.mkdir()
        source.extractall(destination)
        for entry in entries:
            restore_mode(entry, destination.joinpath(*PurePosixPath(entry.orig_filename).parts))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise ValueError("Usage: ci-build-archive.py <archive> <destination>")
    extract_build(sys.argv[1], sys.argv[2])
