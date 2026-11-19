"""Prepare the configured FIFA installation for Boxedwine (Python 3.11+)."""
import configparser
import hashlib
import json
import re
import shutil
import subprocess
import urllib.request
import zipfile
from pathlib import Path
from tempfile import NamedTemporaryFile

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "host.cfg"
STAGE = HERE / "stage"
CONTROLLER = HERE / "controller"
XIDI = CONTROLLER / "xidi"
LOCK = json.loads((HERE / "runtime-lock.json").read_text(encoding="utf-8"))
# Leave native dgVoodoo overrides out of the game ZIP so Wine uses its own graphics libraries.
DGVOODOO_OVERRIDES = {"d3d8.dll", "ddraw.dll", "dgvoodoo.conf"}


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


def fetch(name, url, pin):
    path = STAGE / name
    if path.exists() and digest(path) == pin:
        return
    with NamedTemporaryFile(dir=STAGE, delete=False) as temp:
        partial = Path(temp.name)
    try:
        with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output)
        if digest(partial) != pin:
            raise ValueError(f"SHA-256 mismatch for {name}: the download does not match runtime-lock.json.")
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def game_config(path):
    config = path.read_bytes()
    for name, value in [(b"VIDEO", b"0"), (b"AUDIO", b"1")]:
        pattern = rb"^([ \t]*" + name + rb"[ \t]*=[ \t]*)\d+(?=[ \t]*(?://[^\r\n]*)?\r?$)"
        config, count = re.subn(pattern, lambda match: match[1] + value, config, flags=re.M | re.I)
        if count != 1:
            raise ValueError(f"Expected exactly one {name.decode()} setting in {path}")
    return config


def pack_game(game):
    executable = game / "fifa2003.exe"
    if not executable.is_file():
        raise ValueError(f"Could not find {executable}. Set game_dir to the installed FIFA folder.")
    if digest(executable) != "dff7f9ae1c6ebe6a73f90013e06ebca8453daa101587a9b7bb7bf51aa2149889":
        raise ValueError("This host requires the tested English FIFA 2003 Build 325 executable.")
    config = game_config(game / "soccer.ini")
    data = game / "data"
    if not data.is_dir() or not any(data.iterdir()):
        raise ValueError("Missing game data")
    overlays = {
        "dinput.dll": XIDI / "dinput.dll",
        "Xidi.32.dll": XIDI / "Xidi.32.dll",
        "xinput1_4.dll": CONTROLLER / "xinput1_4.dll",
        "Xidi.ini": CONTROLLER / "Xidi.ini",
        "Xidi-LICENSE.txt": XIDI / "LICENSE",
    }
    for notice in sorted((XIDI / "ThirdParty").iterdir()):
        overlays[f"Xidi-licenses/{notice.name}"] = notice
    excluded = DGVOODOO_OVERRIDES | {"soccer.ini"} | {name.lower() for name in overlays}
    with NamedTemporaryFile(dir=STAGE, delete=False) as temp:
        partial = Path(temp.name)
    try:
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
            for path in sorted(game.rglob("*")):
                relative = path.relative_to(game).as_posix()
                if relative.lower() not in excluded:
                    archive.write(path, relative)
            archive.writestr("soccer.ini", config)
            for name, path in overlays.items():
                archive.write(path, name)
        with zipfile.ZipFile(partial) as archive:
            bad = archive.testzip()
            if bad:
                raise ValueError(f"Failed CRC check for {bad}")
        # Boxedwine uses the ZIP name to look up existing browser saves.
        partial.replace(STAGE / "fifa325-pad.zip")
    finally:
        partial.unlink(missing_ok=True)


def stage_launcher():
    stock = (STAGE / "boxedwine.html").read_text(encoding="utf-8")
    marker = "<script src=boxedwine-shell.js>"
    if stock.count(marker) != 1:
        raise ValueError("Unexpected Boxedwine launcher HTML")
    shared = HERE / "shared"
    for name in ("runner.html", "room.html", "runner.js", "player.js", "game-bridge.js", "controls.js", "peer.js", "seats.js", "fullscreen.js"):
        shutil.copyfile(shared / name, STAGE / name)
    shell = (STAGE / "boxedwine-shell.js").read_text(encoding="utf-8")
    mount = "FS.mkdirTree(Config.d_drive);"
    module = "var Module = {"
    if shell.count(mount) != 1 or shell.count(module) != 1:
        raise ValueError("Unexpected Boxedwine shell initialization")
    shell = shell.replace(mount, mount + "\nwindow.initSharedPad();")
    shell = shell.replace(module, module + """
        onAbort: reason => parent.gameFailed(window, 'Boxedwine stopped: ' + reason),
        onExit: code => parent.gameFailed(window, 'Boxedwine exited (code ' + code + ').'),""")
    (STAGE / "shared-shell.js").write_text(shell, encoding="utf-8")
    (STAGE / "shared-game.html").write_text(
        stock.replace(marker, '<script src="game-bridge.js"></script><script src="shared-shell.js">'),
        encoding="utf-8")


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


def prepare(settings):
    game_dir = settings["host"].get("game_dir", "").strip()
    if not game_dir:
        raise ValueError("Set game_dir in host.cfg to the installed FIFA folder.")
    runtime_url = settings.get("boxedwine", "runtime_url", fallback="").rstrip("/")
    filesystem_url = settings.get("boxedwine", "filesystem_url", fallback="")
    if not runtime_url or not filesystem_url:
        raise ValueError("Set runtime_url and filesystem_url in the [boxedwine] section of host.cfg.")

    game = configured_path(game_dir)
    output = STAGE.resolve()
    if output.is_relative_to(game) or game.is_relative_to(output):
        raise ValueError("Choose a game directory outside the host's generated files.")

    STAGE.mkdir(exist_ok=True)
    print(f"Preparing FIFA from {game}", flush=True)
    if not (game / "fifa2003.exe").is_file():
        raise ValueError(f"Set game_dir in host.cfg to the folder containing fifa2003.exe. Checked {game}")
    install_signaling_dependency()
    for name, metadata in LOCK["runtime"].items():
        fetch(name, f"{runtime_url}/{name}", metadata["sha256"])
    fetch("boxedwine.zip", filesystem_url, LOCK["filesystem"]["archive"]["sha256"])
    pack_game(game)
    stage_launcher()
    print("Prepared. Run python host.py to open the invite room.")


if __name__ == "__main__":
    try:
        prepare(read_settings())
    except (OSError, ValueError, subprocess.CalledProcessError, configparser.Error) as error:
        raise SystemExit(str(error)) from error
