"""Read-only Windows tool metadata and restricted gclient literal parsing."""

import argparse
import ast
import ctypes
import json
import os
from pathlib import Path
import sys


def literal_document(text):
    if len(text.encode("utf-8")) > 1024 * 1024:
        raise ValueError("Configuration exceeds the 1 MiB bound")
    tree = ast.parse(text, mode="exec")
    nodes = list(ast.walk(tree))
    if len(nodes) > 8192:
        raise ValueError("Configuration AST exceeds the node bound")
    result = {}
    for node in nodes:
        if isinstance(node, ast.Dict):
            keys = [ast.literal_eval(key) for key in node.keys]
            if len(keys) != len(set(keys)):
                raise ValueError("Duplicate dictionary key in configuration")
    for statement in tree.body:
        if not isinstance(statement, ast.Assign) or len(statement.targets) != 1:
            raise ValueError("Only literal assignments are allowed; configuration is never executed")
        target = statement.targets[0]
        if not isinstance(target, ast.Name) or target.id in result:
            raise ValueError("Ambiguous configuration assignment")
        result[target.id] = ast.literal_eval(statement.value)
    return result


def file_version(filename):
    if not Path(filename).is_file():
        return None
    from ctypes import wintypes

    version = ctypes.WinDLL("version.dll", winmode=0x00000800, use_last_error=True)
    version.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    version.GetFileVersionInfoSizeW.restype = wintypes.DWORD
    version.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    version.GetFileVersionInfoW.restype = wintypes.BOOL
    version.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR,
                                     ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
    version.VerQueryValueW.restype = wintypes.BOOL
    ignored = wintypes.DWORD()
    size = version.GetFileVersionInfoSizeW(str(filename), ctypes.byref(ignored))
    if not size or size > 4 * 1024 * 1024:
        raise OSError(ctypes.get_last_error(), "Cannot read bounded SDK file-version metadata")
    data = ctypes.create_string_buffer(size)
    if not version.GetFileVersionInfoW(str(filename), 0, size, data):
        raise OSError(ctypes.get_last_error(), "Cannot read SDK file-version resource")
    value = ctypes.c_void_p()
    length = wintypes.UINT()
    if not version.VerQueryValueW(data, "\\", ctypes.byref(value), ctypes.byref(length)):
        raise OSError(ctypes.get_last_error(), "Cannot query SDK fixed file-version metadata")
    if length.value < 13 * ctypes.sizeof(wintypes.DWORD):
        raise ValueError("Truncated SDK fixed file-version metadata")
    words = ctypes.cast(value, ctypes.POINTER(wintypes.DWORD * 13)).contents
    if words[0] != 0xFEEF04BD:
        raise ValueError("Invalid SDK fixed file-version signature")
    return ".".join(str(part) for part in
                    (words[2] >> 16, words[2] & 0xFFFF, words[3] >> 16, words[3] & 0xFFFF))


def windows_metadata(explicit_sdk):
    if sys.platform != "win32":
        raise ValueError("Windows metadata is available only on Windows")
    import winreg

    roots = []
    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                               r"SOFTWARE\Microsoft\Windows Kits\Installed Roots",
                               0, winreg.KEY_READ | view) as key:
                value, kind = winreg.QueryValueEx(key, "KitsRoot10")
                if kind not in (winreg.REG_SZ, winreg.REG_EXPAND_SZ):
                    raise ValueError("Unexpected SDK root registry type")
                root = str(Path(os.path.expandvars(value)))
                if root.lower() not in [entry.lower() for entry in roots]:
                    roots.append(root)
        except FileNotFoundError:
            continue
    selected = explicit_sdk or (roots[0] if len(roots) == 1 else None)
    versions = {}
    if selected:
        for relative in (r"bin\10.0.26100.0\x64\rc.exe",
                         r"Debuggers\x64\dbghelp.dll", r"Debuggers\x64\dbgcore.dll"):
            versions[relative] = file_version(Path(selected) / relative)
    return {"pythonVersion": list(sys.version_info[:3]), "pythonPointerBits": ctypes.sizeof(ctypes.c_void_p) * 8,
            "sdkRoots": roots,
            "selectedSdkRoot": selected, "sdkFileVersions": versions}


def gclient_runtime(spec):
    import importlib
    import importlib.metadata
    import site

    prefix = Path(sys.prefix).resolve()
    if prefix == Path(sys.base_prefix).resolve():
        raise ValueError("gclient requires a separately provisioned venv, not the host interpreter")
    if sys.implementation.name != "cpython" or list(sys.version_info[:2]) != spec["python"] or \
            ctypes.sizeof(ctypes.c_void_p) * 8 != spec["pointerBits"]:
        raise ValueError("gclient requires the pinned CPython 3.11 x64 runtime")
    if sys.flags.no_site or sys.flags.isolated or not sys.flags.no_user_site or not sys.flags.ignore_environment:
        raise ValueError("gclient must retain its script directory and venv site-packages with -E -s, not -I/-S")
    config = prefix / "pyvenv.cfg"
    settings = {}
    for line in config.read_text(encoding="utf-8-sig").splitlines():
        if "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        key = key.lower()
        if key in settings:
            raise ValueError("Duplicate pyvenv.cfg setting")
        settings[key] = value
    if settings.get("include-system-site-packages", "").lower() != "false" or site.ENABLE_USER_SITE:
        raise ValueError("gclient venv must exclude system and user site-packages")
    packages = prefix / "Lib" / "site-packages"
    observed = []
    for requirement in spec["requirements"]:
        distribution = importlib.metadata.distribution(requirement["distribution"])
        if distribution.version != requirement["version"]:
            raise ValueError("Wrong gclient dependency version: " + requirement["distribution"])
        if not Path(distribution.locate_file("")).resolve().is_relative_to(packages):
            raise ValueError("gclient distribution was resolved outside its dedicated venv")
        module = importlib.import_module(requirement["module"])
        if not getattr(module, "__file__", None) or not Path(module.__file__).resolve().is_relative_to(packages):
            raise ValueError("gclient import was resolved outside its dedicated venv")
        for name in requirement["imports"]:
            importlib.import_module(name)
        observed.append({"distribution": requirement["distribution"], "version": distribution.version,
                         "module": requirement["module"], "origin": str(Path(module.__file__).resolve())})
    return {"pythonVersion": list(sys.version_info[:3]), "pythonPointerBits": ctypes.sizeof(ctypes.c_void_p) * 8,
            "pythonImplementation": sys.implementation.name,
            "prefix": str(prefix), "basePrefix": sys.base_prefix, "executable": sys.executable,
            "includeSystemSitePackages": False, "requirements": observed}


def self_test():
    good = literal_document("solutions = [{'name': 'src', 'managed': False}]\ncache_dir = None\n")
    assert good["solutions"][0]["managed"] is False and good["cache_dir"] is None
    bad = ("import os", "solutions = __import__('os').getcwd()", "a = 1\na = 2",
           "entries = {'src': 'a', 'src': 'b'}", "a = b = 1")
    for text in bad:
        try:
            literal_document(text)
        except (ValueError, TypeError, SyntaxError):
            pass
        else:
            raise AssertionError("Executable/ambiguous configuration was accepted")
    return {"success": True, "tests": 6, "network": False, "mutations": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("metadata", "literal", "gclient-runtime", "self-test"))
    parser.add_argument("--sdk-root")
    args = parser.parse_args()
    if args.mode == "metadata":
        result = windows_metadata(args.sdk_root)
    elif args.mode == "literal":
        data = sys.stdin.buffer.read(1024 * 1024 + 1)
        result = literal_document(data.decode("utf-8-sig"))
    elif args.mode == "gclient-runtime":
        data = sys.stdin.buffer.read(65537)
        if len(data) > 65536:
            raise ValueError("gclient runtime specification exceeds its bound")
        result = gclient_runtime(json.loads(data.decode("utf-8")))
    else:
        result = self_test()
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, SyntaxError, RecursionError, ImportError) as error:
        print(json.dumps({"code": "ERR_RTC_METADATA", "message": str(error)}), file=sys.stderr)
        sys.exit(1)
