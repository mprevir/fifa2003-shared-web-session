"""Prepare the configured native FIFA installation (Python 3.11+)."""
import configparser
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "host.cfg"


def read_settings():
    parser = configparser.ConfigParser(interpolation=None)
    if not parser.read(CONFIG, encoding="utf-8-sig"):
        raise ValueError("Could not read host.cfg. Restore the file from the repository and set game_dir.")
    if not parser.has_section("host"):
        raise ValueError("Add the [host] section to host.cfg.")
    return parser


def configured_path(value):
    return (CONFIG.parent / Path(value).expanduser()).resolve()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_game(game):
    executable = game / "fifa2003.exe"
    if not executable.is_file():
        raise ValueError(f"Could not find {executable}. Set game_dir to the installed FIFA folder.")
    if digest(executable) != "dff7f9ae1c6ebe6a73f90013e06ebca8453daa101587a9b7bb7bf51aa2149889":
        raise ValueError("This host requires the tested English FIFA 2003 Build 325 executable.")
    data = game / "data"
    if not (game / "soccer.ini").is_file() or not data.is_dir() or not any(data.iterdir()):
        raise ValueError(f"Missing soccer.ini or game data in {game}")
    return executable


def native_executable(settings):
    if os.name != "nt":
        raise ValueError("Native hosting requires Windows.")
    game = configured_game(settings)
    executable = validate_game(game)
    for name in ("D3D8.dll", "DDraw.dll", "dgVoodoo.conf"):
        if not (game / name).is_file():
            raise ValueError(f"Missing native graphics file {name} in {game}")
    return executable


def install_signaling_dependency():
    node = shutil.which("node")
    if not node or int(subprocess.check_output([node, "-p", "process.versions.node.split('.')[0]"], text=True)) < 24:
        raise ValueError("Install Node.js 24 or newer before preparing the invite host.")
    expected = json.loads((HERE / "package-lock.json").read_text())["packages"]["node_modules/ws"]["version"]
    installed = HERE / "node_modules" / "ws" / "package.json"
    if installed.is_file():
        try:
            if json.loads(installed.read_text()).get("version") == expected:
                return
        except json.JSONDecodeError:
            pass
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise ValueError("Install npm before preparing the invite host.")
    subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=HERE, check=True)


def configured_game(settings):
    game_dir = settings["host"].get("game_dir", "").strip()
    if not game_dir:
        raise ValueError("Set game_dir in host.cfg to the installed FIFA folder.")
    return configured_path(game_dir)


if __name__ == "__main__":
    try:
        executable = native_executable(read_settings())
        install_signaling_dependency()
        print(f"Prepared {executable}. Run python host.py to start the room.")
    except (OSError, ValueError, subprocess.CalledProcessError, configparser.Error) as error:
        raise SystemExit(str(error)) from error
