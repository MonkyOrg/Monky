"""Apply the private pinned SDK VFS to every clang-cl translation unit."""

import os
import re
import subprocess
import sys


def main():
    if len(sys.argv) < 6 or sys.argv[3] != "--" or not re.fullmatch(r"[a-f0-9]{64}", sys.argv[2]):
        raise ValueError("Expected VFS manifest, content digest, --, clang-cl and compiler arguments")
    manifest, compiler = sys.argv[1], sys.argv[4]
    if not os.path.isabs(manifest) or not os.path.isfile(manifest):
        raise ValueError("The private SDK VFS manifest must be an existing absolute path")
    if os.path.basename(compiler).lower() != "clang-cl.exe":
        raise ValueError("The pinned SDK overlay only supports the configured clang-cl")
    # LLVM's supported VFS changes compiler input resolution, not checkout bytes
    # or private class access. The owning build verifies both input hash sets.
    arguments = [compiler, *sys.argv[5:], "/clang:-ivfsoverlay", "/clang:" + manifest]
    # The opt-in mapping's provisional guards must unwind across a decoder's
    # exception. Keep this local to that SDK unit, not all of libwebrtc.
    decoder_unit = os.path.join("modules", "video_coding", "generic_decoder.cc")
    if any(not arg.startswith(("-", "/")) and
           os.path.normcase(os.path.abspath(arg)).endswith(os.sep + decoder_unit)
           for arg in sys.argv[5:]):
        arguments.append("/EHsc")
    return subprocess.run(arguments, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
