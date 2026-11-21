import { spawn } from "node:child_process";
import { dirname } from "node:path";

export function nativeGame(executable) {
  let active;

  function stop() {
    if (!active) return;
    if (!active.stopping) {
      active.stopping = true;
      active.child.kill();
    }
    return active.closed;
  }

  async function start(onExit, isStarting) {
    await active?.closed;
    if (!isStarting()) return;
    // A shell's compatibility settings must not carry over to the game.
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([name]) => name.toUpperCase() !== "__COMPAT_LAYER",
    ));
    const child = spawn(executable, [], { cwd: dirname(executable), env, stdio: "ignore" });
    const game = active = { child, stopping: false };
    game.closed = new Promise(resolve => child.once("close", (code, signal) => {
      if (active === game) active = undefined;
      resolve();
      if (!game.stopping && game.started) {
        const status = code >= 0x80000000 ? `0x${code.toString(16)}` : code;
        onExit(`FIFA exited (${signal ?? status}).`);
      }
    }));
    await new Promise((resolve, reject) => {
      child.on("error", error => {
        if (game.started) console.error("FIFA process error:", error);
        else reject(error);
      });
      child.once("spawn", () => {
        game.started = true;
        resolve();
      });
    });
  }

  return { start, stop };
}
