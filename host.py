"""Start the FIFA lobby on the Windows host."""
import configparser
import json
import os
import shutil
import subprocess
import time
from contextlib import ExitStack
from ipaddress import IPv4Address
from pathlib import Path

from prepare import CONFIG, HERE, LOCK, STAGE, read_settings

SHARED = HERE / "shared"


def stop(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def find_caddy(config_path, configured):
    if configured:
        caddy = shutil.which(str(config_path.parent / Path(configured).expanduser()))
    else:
        caddy = shutil.which("caddy")
    if not caddy:
        raise ValueError("Set caddy_path in the host config or install Caddy on PATH for LAN play.")
    return caddy


def public_certificate(caddy, env):
    output = subprocess.check_output([caddy, "environ"], env=env, text=True, encoding="utf-8")
    for line in output.splitlines():
        name, _, value = line.partition("=")
        if name == "caddy.AppDataDir":
            return Path(value) / "pki" / "authorities" / "local" / "root.crt"
    raise ValueError("Caddy did not report its certificate directory.")


def main():
    config_path = CONFIG
    config = read_settings()["host"]

    required = (*LOCK["runtime"], "boxedwine.zip", "fifa325-pad.zip", "runner.html",
                "shared-game.html", "shared-shell.js", "room.html", "runner.js", "player.js",
                "peer.js", "controls.js", "seats.js", "fullscreen.js", "game-bridge.js")
    if any(not (STAGE / name).is_file() for name in required) or not (HERE / "node_modules" / "ws" / "package.json").is_file():
        raise ValueError("Prepared files are missing. Run python prepare.py first.")

    node = shutil.which("node")
    if not node:
        raise ValueError("Install Node.js before starting the invite host.")
    env = os.environ.copy()
    for option, default in (("reconnect_seconds", 30), ("startup_seconds", 180)):
        value = config.getint(option, fallback=default)
        if not 1 <= value <= 600:
            raise ValueError(f"{option} must be between 1 and 600 in {config_path}.")
        env["FIFA_" + option.upper()] = str(value)
    try:
        port = config.getint("lan_port", fallback=18444)
    except ValueError:
        raise ValueError(f"lan_port must be an integer in {config_path}.") from None
    if not 1024 <= port <= 65535:
        raise ValueError(f"lan_port must be between 1024 and 65535 in {config_path}.")
    env["FIFA_LAN_PORT"] = str(port)

    lan_ip = config.get("lan_ip", "").strip()
    env.pop("FIFA_LAN_IP", None)
    if lan_ip:
        address = IPv4Address(lan_ip)
        if address.is_unspecified or address.is_loopback or address.is_multicast:
            raise ValueError("Set lan_ip to the host's LAN IPv4 address from ipconfig.")
        env["FIFA_LAN_IP"] = str(address)
        caddy = find_caddy(config_path, config.get("caddy_path", "").strip())
        certificate = public_certificate(caddy, env)

    with ExitStack() as processes:
        origin = subprocess.Popen([node, "server.mjs"], cwd=HERE, env=env,
                                  stdout=subprocess.PIPE, text=True, encoding="utf-8")
        processes.callback(origin.stdout.close)
        processes.callback(stop, origin)
        services = {"Node": origin}
        ready = origin.stdout.readline()
        if not ready:
            raise RuntimeError(f"Node stopped before the runner was ready (exit code {origin.wait()}).")
        listener = json.loads(ready)
        env["FIFA_UPSTREAM"] = listener["upstream"]
        print(f"Windows runner (keep this URL private): {listener['runnerUrl']}", flush=True)
        if lan_ip:
            proxy = subprocess.Popen([caddy, "run", "--config", str(SHARED / "Caddyfile"), "--adapter", "caddyfile"],
                                     cwd=HERE, env=env)
            processes.callback(stop, proxy)
            services["Caddy"] = proxy
            print(f"LAN player address: https://{env['FIFA_LAN_IP']}:{env['FIFA_LAN_PORT']}", flush=True)
            print(f"Public CA certificate (available after Caddy starts): {certificate}", flush=True)

        print("Leave this terminal open while playing. Ctrl+C stops the invite host.", flush=True)
        while True:
            for name, process in services.items():
                status = process.poll()
                if status is not None:
                    raise RuntimeError(f"{name} stopped (exit code {status}). See its output above.")
            time.sleep(0.25)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError, RuntimeError, configparser.Error, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
