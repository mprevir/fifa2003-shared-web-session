import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { localRunner } from "./shared/service.mjs";
import { attachRoom } from "./shared/room.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, "stage");
const port = Number(process.env.FIFA_NODE_PORT);
const host = "127.0.0.1";

async function inviteSettings() {
    const directory = join(scriptDir, "shared", ".host");
    const file = join(directory, "identity.json");
    await mkdir(directory, { recursive: true });
    try {
        await writeFile(file, JSON.stringify({
            roomId: randomBytes(16).toString("base64url"),
            runnerKey: randomBytes(32).toString("base64url"),
        }) + "\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
    }
    const { roomId, runnerKey } = JSON.parse(await readFile(file, "utf8"));
    if (![roomId, runnerKey].every(value => typeof value === "string" && /^[\w-]+$/.test(value)) ||
        roomId.length !== 22 || runnerKey.length !== 43) throw new Error("Invalid invite identity in " + file);
    const reconnectMs = Number(process.env.FIFA_RECONNECT_SECONDS ?? 30) * 1000;
    const startupMs = Number(process.env.FIFA_STARTUP_SECONDS ?? 180) * 1000;
    if (![reconnectMs, startupMs].every(value => Number.isInteger(value) && value >= 1000 && value <= 600000)) {
        throw new Error("Invite timeouts must be between 1 and 600 seconds.");
    }
    return { roomId, runnerKey, reconnectMs, startupMs };
}

const room = await inviteSettings();
const roomPath = `/room/${room.roomId}`;

const mimeTypes = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".mjs", "text/javascript; charset=utf-8"],
    [".wasm", "application/wasm"],
    [".zip", "application/zip"],
]);

function resolveRequestPath(pathname) {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    const absolute = join(root, relative);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
        return null;
    }
    return absolute;
}

const server = createServer(async (request, response) => {
    let filePath;
    let isRoom = false;
    try {
        const { pathname } = new URL(request.url || "/", "http://localhost");
        isRoom = pathname === roomPath;
        filePath = resolveRequestPath(isRoom ? "/room.html" : pathname);
    } catch (error) {
        if (!(error instanceof URIError) && !(error instanceof TypeError)) throw error;
        response.writeHead(400);
        response.end("Bad request");
        return;
    }
    if (!filePath || (["runner.html", "shared-game.html"].some(name =>
        filePath.toLowerCase() === join(root, name).toLowerCase()) && !localRunner(request))) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
    }
    if (!isRoom && filePath.toLowerCase() === join(root, "room.html").toLowerCase()) {
        response.writeHead(404);
        response.end("Not found");
        return;
    }

    let info;
    try {
        info = await stat(filePath);
    } catch (error) {
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
        "Content-Type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        ...(extname(filePath) !== ".zip" && extname(filePath) !== ".wasm" &&
            { "Cache-Control": "no-store" }),
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

attachRoom(server, room);
server.on("error", error => {
    console.error(error.code === "EADDRINUSE"
        ? `Port ${port} is already in use on ${host}. Choose another node_port in host.cfg.`
        : error.message);
    process.exitCode = 1;
});
server.listen(port, host, () => {
    const origin = `http://${host}:${server.address().port}`;
    console.log(`Windows runner (keep this URL private): ${origin}/runner.html#key=${room.runnerKey}`);
    console.log(`Local player invite: ${origin}${roomPath}`);
    if (process.env.FIFA_LAN_IP) {
        const lanPort = process.env.FIFA_LAN_PORT ?? 8444;
        console.log(`LAN player invite: https://${process.env.FIFA_LAN_IP}:${lanPort}${roomPath}`);
    }
});
