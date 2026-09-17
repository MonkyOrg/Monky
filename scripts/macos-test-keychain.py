"""Provide an isolated, unlocked Keychain for real native and Electron CI tests."""

import json
import os
import pathlib
import secrets
import shlex
import subprocess
import sys


def security(*args):
    return subprocess.check_output(["security", *args], text=True).strip()


def setup(state_file):
    if state_file.exists():
        raise RuntimeError("A previous test Keychain fixture was not restored")
    keychain = str(state_file.parent / ("monky-test-" + secrets.token_hex(8) + ".keychain-db"))
    previous = {
        "default": shlex.split(security("default-keychain", "-d", "user"))[0],
        "search": shlex.split(security("list-keychains", "-d", "user")),
        "fixture": keychain,
    }
    state_file.write_text(json.dumps(previous), encoding="utf-8")
    password = secrets.token_hex(24)
    print("::add-mask::" + password, flush=True)
    security("create-keychain", "-p", password, keychain)
    security("set-keychain-settings", "-lut", "21600", keychain)
    security("unlock-keychain", "-p", password, keychain)
    security("list-keychains", "-d", "user", "-s", keychain)
    security("default-keychain", "-d", "user", "-s", keychain)


def restore(state_file):
    if not state_file.exists():
        return
    previous = json.loads(state_file.read_text(encoding="utf-8"))
    operations = [
        ["list-keychains", "-d", "user", "-s", *previous["search"]],
        ["default-keychain", "-d", "user", "-s", previous["default"]],
    ]
    if pathlib.Path(previous["fixture"]).exists():
        operations.append(["delete-keychain", previous["fixture"]])
    errors = []
    for args in operations:
        result = subprocess.run(["security", *args], text=True, capture_output=True)
        if result.returncode:
            errors.append(args[0] + ": " + result.stderr.strip())
    if errors:
        raise RuntimeError("Test Keychain cleanup failed: " + "; ".join(errors))
    state_file.unlink()


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("setup", "restore"):
        raise SystemExit("Usage: macos-test-keychain.py setup|restore")
    state = pathlib.Path(os.environ["RUNNER_TEMP"]) / "monky-test-keychain-state.json"
    (setup if sys.argv[1] == "setup" else restore)(state)
