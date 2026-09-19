import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sdk", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--root-target", required=True)
    parser.add_argument("--licenses", required=True)
    args = parser.parse_args()
    sdk = Path(args.sdk).resolve()
    spec = importlib.util.spec_from_file_location(
        "webrtc_licenses", sdk / "tools_webrtc" / "libs" / "generate_licenses.py"
    )
    upstream = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upstream)

    class NativeLicenseBuilder(upstream.LicenseBuilder):
        @staticmethod
        def _run_gn(buildfile_dir, target):
            return subprocess.check_output(
                [
                    str(sdk / "buildtools" / "win" / "gn.exe"),
                    "desc", str(Path(buildfile_dir).resolve()), target,
                    "--all", "--format=json", f"--root={sdk}",
                    f"--root-target={args.root_target}",
                    f"--script-executable={sys.executable}", "--threads=1",
                ],
                cwd=sdk,
                encoding="utf-8",
            )

        def _get_third_party_libraries(self, buildfile_dir, target):
            graph = json.loads(self._run_gn(buildfile_dir, target))
            return {
                library for description in graph.values()
                for dependency in description["deps"]
                if (library := self._parse_library(dependency))
            }

    destination = Path(args.licenses).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    builder = NativeLicenseBuilder([args.output], [args.root_target + ":monky_screen_rtc"])
    builder.generate_license_text(str(destination))
    libraries = sorted(builder._get_third_party_libraries(args.output, args.root_target + ":monky_screen_rtc"))
    (destination / "libraries.json").write_text(json.dumps(libraries, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"nativeRtcLicenses": libraries}))


if __name__ == "__main__":
    main()
