"""Use the pinned WebRTC commit time for deterministic PE timestamps."""

from pathlib import Path
import re
import sys

if sys.argv[1:] != ["default"]:
    raise SystemExit("Only the configured native screen build is supported")
text = Path(__file__).with_name("pinned_epoch.txt").read_text(encoding="ascii")
if not re.fullmatch(r"[0-9]{1,10}\n?", text) or not 0 < int(text) < 2**32:
    raise SystemExit("Invalid pinned WebRTC commit timestamp")
print(int(text))
