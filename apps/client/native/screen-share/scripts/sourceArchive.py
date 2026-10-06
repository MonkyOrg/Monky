import argparse
import contextlib
import json
import os
import posixpath
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile


def safe_member(value):
    member = PurePosixPath(value)
    if not value or member.is_absolute() or ".." in member.parts or ":" in value or "\n" in value or "\r" in value:
        raise ValueError(f"Unsafe source archive member: {value!r}")
    return str(member)


def find_xz():
    mode = os.environ.get("MONKY_SOURCE_XZ")
    if mode == "python":
        return None
    found = shutil.which("xz")
    if not found and os.name == "nt" and shutil.which("git"):
        # Git for Windows ships xz, but its tool directories are not always on PATH.
        install = Path(shutil.which("git")).resolve().parent.parent
        found = next((str(candidate) for candidate in (install / "mingw64" / "bin" / "xz.exe",
                                                       install / "usr" / "bin" / "xz.exe") if candidate.is_file()), None)
    if not found and mode == "required":
        raise RuntimeError("Corresponding sources require a parallel xz executable (MONKY_SOURCE_XZ=required).")
    return found


@contextlib.contextmanager
def xz_pipe(xz, filename, write):
    # Python's lzma uses one thread; xz splits the same single .xz stream into blocks across all cores.
    with open(filename, "wb" if write else "rb") as file:
        command = [xz, "--threads=0", "--stdout"] + (["-3", "--compress"] if write else ["--decompress"])
        process = subprocess.Popen(command, stdin=subprocess.PIPE if write else file,
                                   stdout=file if write else subprocess.PIPE)
        pipe = process.stdin if write else process.stdout
        try:
            yield pipe
            if not write:
                while pipe.read(1 << 20):
                    pass
        except BaseException:
            process.kill()
            process.wait()
            raise
        finally:
            pipe.close()
        if process.wait() != 0:
            raise RuntimeError(f"xz failed with exit code {process.returncode}")


def open_xz_tar(stack, filename, write=False):
    xz = find_xz()
    if xz:
        stream = stack.enter_context(xz_pipe(xz, filename, write))
        return stack.enter_context(tarfile.open(fileobj=stream, mode="w|" if write else "r|",
                                                format=tarfile.PAX_FORMAT))
    if write:
        return stack.enter_context(tarfile.open(filename, "w:xz", format=tarfile.PAX_FORMAT, preset=3))
    return stack.enter_context(tarfile.open(filename, "r|xz"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--list", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-internal-symlinks", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    metadata = Path(args.metadata).resolve()
    entries = Path(args.list).read_text(encoding="utf-8").splitlines()
    members = [(safe_member(value), value.endswith("/")) for value in entries]
    inventory = {relative for relative, _ in members}
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

    with contextlib.ExitStack() as stack:
        archive = open_xz_tar(stack, args.output, write=True)
        kinds = []
        for index, (relative, directory) in enumerate(members):
            filename = root.joinpath(*PurePosixPath(relative).parts)
            alias = filename.is_symlink()
            if alias:
                if not args.allow_internal_symlinks or filename.readlink().is_absolute():
                    raise ValueError(f"Unexpected source alias: {relative}")
                target = filename.resolve(strict=False).relative_to(root).as_posix()
                if filename.exists() and target not in inventory:
                    raise ValueError(f"Source alias target is missing from the archive: {relative}")
            elif not (filename.is_dir() if directory else filename.is_file()):
                raise ValueError(f"Source changed into an alias or changed type: {relative}")
            kinds.append(alias)
            archive.add(filename, arcname=relative, recursive=False, filter=public_metadata)
            if (index + 1) % 25000 == 0:
                print(json.dumps({"sourceEntriesArchived": index + 1, "total": len(members)}), flush=True)
        for relative in extra:
            archive.add(metadata / relative, arcname=relative, recursive=False, filter=public_metadata)

    expected = [(relative, directory, alias) for (relative, directory), alias in zip(members, kinds)]
    expected += [(relative, False, False) for relative in extra]
    count = 0
    with contextlib.ExitStack() as stack:
        for member in open_xz_tar(stack, args.output):
            if count >= len(expected) or (member.name, member.isdir(), member.issym()) != expected[count]:
                raise ValueError(f"Source archive inventory mismatch at entry {count}: {member.name}")
            if not member.isdir() and not member.isfile() and not (args.allow_internal_symlinks and member.issym()):
                raise ValueError("Source archive contains an unexpected entry type.")
            if member.uname or member.gname:
                raise ValueError("Source archive leaked local account metadata.")
            count += 1
    if count != len(expected):
        raise ValueError("Source archive omitted an input.")
    print(json.dumps({"sourceArchiveVerified": True, "members": count,
                      "compressor": "xz --threads=0" if find_xz() else "python-lzma"}), flush=True)


def verify_manifest(archive, manifest_file):
    previous = json.loads(Path(manifest_file).read_text(encoding="utf-8"))
    previous.pop("archive")
    seen = set()
    found = False
    mac_links = previous.get("platform") == "darwin"
    with contextlib.ExitStack() as stack:
        source = open_xz_tar(stack, archive)
        for member in source:
            name = safe_member(member.name)
            alias = mac_links and member.issym() and not PurePosixPath(member.linkname).is_absolute()
            if alias:
                safe_member(posixpath.normpath(str(PurePosixPath(name).parent / member.linkname)))
            if name in seen or not (member.isfile() or member.isdir() or alias) or member.uname or member.gname:
                raise ValueError("Unsafe or duplicate corresponding-source archive member.")
            seen.add(name)
            if name == "SOURCE-MANIFEST.json":
                if not member.isfile() or member.size > 1_000_000 or json.load(source.extractfile(member)) != previous:
                    raise ValueError("Embedded source provenance disagrees with the verified CI manifest.")
                found = True
    if not found:
        raise ValueError("Missing embedded corresponding-source manifest.")


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "verify":
        verify_manifest(*sys.argv[2:])
    else:
        main()
