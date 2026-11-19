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
    const child = spawn(executable, [], { cwd: dirname(executable), stdio: "ignore" });
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
