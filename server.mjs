import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { localRunner, playerOrigin } from "./shared/service.mjs";
import { nativeGame } from "./native/game.mjs";
import { attachRoom } from "./shared/room.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const executable = process.env.FIFA_NATIVE_EXE;
if (!executable) throw new Error("Start the native host with python host.py.");
const game = nativeGame(executable);
const root = join(scriptDir, "shared");
const host = "127.0.0.1";

async function inviteSettings() {
    const directory = join(scriptDir, "shared", ".host");
    const file = join(directory, "identity.json");
    await mkdir(directory, { recursive: true });
    try {
        await writeFile(file, JSON.stringify({
            runnerKey: randomBytes(32).toString("base64url"),
        }) + "\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
    }
    const { runnerKey } = JSON.parse(await readFile(file, "utf8"));
    if (typeof runnerKey !== "string" || !/^[\w-]{43}$/.test(runnerKey)) {
        throw new Error("Invalid runner key in " + file);
    }
    const reconnectMs = Number(process.env.FIFA_RECONNECT_SECONDS ?? 30) * 1000;
    const startupMs = Number(process.env.FIFA_STARTUP_SECONDS ?? 180) * 1000;
    if (![reconnectMs, startupMs].every(value => Number.isInteger(value) && value >= 1000 && value <= 600000)) {
        throw new Error("Invite timeouts must be between 1 and 600 seconds.");
    }
    const playerHost = process.env.FIFA_LAN_IP && `${process.env.FIFA_LAN_IP}:${process.env.FIFA_LAN_PORT}`;
    return { runnerKey, playerHost, reconnectMs, startupMs };
}

const room = await inviteSettings();
const playerAssets = new Set(["/player.js", "/peer.js", "/seats.js", "/fullscreen.js"]);
const nativeRunnerAssets = new Set(["/runner.html", "/native.js"]);

const server = createServer(async (request, response) => {
    const pathname = request.url.split("?", 1)[0];
    const isPlayer = playerOrigin(request, room.playerHost);
    const isRunner = localRunner(request) && nativeRunnerAssets.has(pathname);
    if (!isRunner && !(isPlayer && (pathname === "/" || playerAssets.has(pathname)))) {
        response.writeHead(404);
        response.end("Not found");
        return;
    }
    const asset = pathname === "/" ? "room.html" : pathname === "/runner.html" ? "native.html" : pathname.slice(1);
    const filePath = join(root, asset);
    let info;
    try {
        info = await stat(filePath);
    } catch {
        response.writeHead(404);
        response.end("Not found");
        return;
    }

    if (!info.isFile()) {
        response.writeHead(404);
        response.end("Not found");
        return;
    }
    response.writeHead(200, {
        "Content-Length": info.size,
        "Content-Type": extname(filePath) === ".html" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
    });
    if (request.method === "HEAD") {
        response.end();
        return;
    }
    pipeline(createReadStream(filePath), response, (error) => {
        if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE") {
            console.error(`Could not serve ${filePath}: ${error.message}`);
        }
    });
});

attachRoom(server, { ...room, nativeGame: game });
async function shutdown() {
    await game.stop();
    process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
if (process.env.FIFA_MANAGED_HOST === "1") {
    process.stdin.once("end", shutdown);
    process.stdin.resume();
}
server.on("error", error => {
    console.error(error.message);
    process.exitCode = 1;
});
server.listen(0, host, () => {
    const upstream = `${host}:${server.address().port}`;
    console.log(JSON.stringify({ upstream, runnerUrl: `http://${upstream}/runner.html#key=${room.runnerKey}` }));
});
