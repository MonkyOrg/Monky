import argparse
import json
from pathlib import Path, PurePosixPath
import tarfile


def safe_member(value):
    member = PurePosixPath(value)
    if not value or member.is_absolute() or ".." in member.parts or ":" in value or "\n" in value or "\r" in value:
        raise ValueError(f"Unsafe source archive member: {value!r}")
    return str(member)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--list", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    metadata = Path(args.metadata).resolve()
    entries = Path(args.list).read_text(encoding="utf-8").splitlines()
    members = [(safe_member(value), value.endswith("/")) for value in entries]
    extra = ["SOURCE-MANIFEST.json", "SOURCE-README.md", "SOURCE-README.en.md"]
    patches = metadata / "SOURCE-PATCHES"
    if patches.exists():
        if patches.is_symlink() or not patches.is_dir():
            raise ValueError("Maintained source patch root must be a real directory.")
        for filename in sorted(patches.rglob("*")):
            if filename.is_symlink() or not (filename.is_dir() or filename.is_file()):
                raise ValueError("Maintained source patches contain an alias or unsupported file type.")
            if filename.is_file():
                extra.append(safe_member(filename.relative_to(metadata).as_posix()))

    def public_metadata(info):
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        return info

    with tarfile.open(args.output, "w:xz", format=tarfile.PAX_FORMAT, preset=3) as archive:
        for index, (relative, directory) in enumerate(members):
            filename = root.joinpath(*PurePosixPath(relative).parts)
            if filename.is_symlink() or not (filename.is_dir() if directory else filename.is_file()):
                raise ValueError(f"Source changed into an alias or changed type: {relative}")
            archive.add(filename, arcname=relative, recursive=False, filter=public_metadata)
            if (index + 1) % 25000 == 0:
                print(json.dumps({"sourceEntriesArchived": index + 1, "total": len(members)}), flush=True)
        for relative in extra:
            archive.add(metadata / relative, arcname=relative, recursive=False, filter=public_metadata)

    expected = members + [(relative, False) for relative in extra]
    count = 0
    with tarfile.open(args.output, "r|xz") as archive:
        for member in archive:
            if count >= len(expected) or (member.name, member.isdir()) != expected[count]:
                raise ValueError(f"Source archive inventory mismatch at entry {count}: {member.name}")
            if not member.isdir() and not member.isfile():
                raise ValueError("Source archive contains an unexpected entry type.")
            if member.uname or member.gname:
                raise ValueError("Source archive leaked local account metadata.")
            count += 1
    if count != len(expected):
        raise ValueError("Source archive omitted an input.")
    print(json.dumps({"sourceArchiveVerified": True, "members": count}), flush=True)


if __name__ == "__main__":
    main()
