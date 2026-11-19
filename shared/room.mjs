import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { lanPlayer, localRunner } from "./service.mjs";

export function attachRoom(server, { runnerKey, playerHost, reconnectMs, startupMs }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const visitors = new Set();
  const seats = new Map();
  let runner, session, cleanupTimer, reason;

  function send(ws, message) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function snapshot() {
    const phase = session?.phase ?? (runner ? "idle" : "offline");
    const occupancy = Object.fromEntries([1, 2].map(seat => {
      const player = seats.get(seat);
      return [seat, !player ? "open" : player.ws ? "occupied" : "reconnecting"];
    }));
    for (const player of runner ? [runner, ...visitors] : visitors) {
      send(player.ws, {
        type: "status", phase, reason, session: session?.id,
        seat: player.seat ?? null, seats: occupancy,
      });
    }
  }

  function connectPeer(visitor) {
    if (visitor === runner || !visitor.ws || visitor.peer || session.phase !== "streaming") return;
    visitor.peer = randomUUID();
    send(runner.ws, { type: "peer", session: session.id, seat: visitor.seat, peer: visitor.peer });
  }

  function disconnectPeer(visitor) {
    if (!visitor.peer) return;
    send(runner?.ws, { type: "leave", session: session.id, seat: visitor.seat, peer: visitor.peer });
    visitor.peer = null;
  }

  function releaseSeat(player) {
    clearTimeout(player.hold);
    disconnectPeer(player);
    seats.delete(player.seat);
    player.seat = null;
  }

  function updateRoom() {
    snapshot();
    for (const player of seats.values()) connectPeer(player);
  }

  function reset() {
    clearTimeout(cleanupTimer);
    for (const player of seats.values()) releaseSeat(player);
    session = null;
    snapshot();
  }

  function stop(message) {
    if (!session || session.phase === "stopping") return;
    clearTimeout(cleanupTimer);
    reason = message;
    session.phase = "stopping";
    for (const player of seats.values()) releaseSeat(player);
    send(runner.ws, { type: "stop", session: session.id });
    snapshot();
    cleanupTimer = setTimeout(() => runner?.ws.terminate(), 10000);
  }

  function start() {
    if (session) return;
    reason = undefined;
    session = { id: randomUUID(), phase: "starting" };
    send(runner.ws, { type: "start", session: session.id });
    cleanupTimer = setTimeout(() => stop("Game startup timed out."), startupMs);
    snapshot();
  }

  function registerVisitor(ws, credential) {
    const returning = [...seats.values()].find(player => player.token && player.token === credential);
    const visitor = returning ?? { token: randomBytes(16).toString("base64url") };
    if (returning) {
      clearTimeout(visitor.hold);
      disconnectPeer(visitor);
      visitor.ws?.close(1008, "This seat was opened in another page.");
    }
    visitor.ws = ws;
    visitors.add(visitor);
    send(ws, { type: "hello", credential: visitor.token });
    updateRoom();
    return visitor;
  }

  function removeVisitor(visitor, ws) {
    if (visitor.ws !== ws) return;
    visitors.delete(visitor);
    visitor.ws = null;
    disconnectPeer(visitor);
    if (visitor.seat) {
      visitor.hold = setTimeout(() => {
        releaseSeat(visitor);
        snapshot();
      }, reconnectMs);
    }
    snapshot();
  }

  function playerMessage(player, message) {
    if (!session || message.session !== session.id || session.phase === "stopping") return;
    if (message.type === "claim") {
      const seat = message.seat;
      if (!player.seat && (seat === 1 || seat === 2) && !seats.has(seat)) {
        player.seat = seat;
        seats.set(seat, player);
      }
      return updateRoom();
    }
    if (message.type === "leave") {
      if (player.seat && player.seat === message.seat) releaseSeat(player);
      return snapshot();
    }
    if (message.type === "answer" && session.phase === "streaming" && player.peer &&
        message.peer === player.peer && typeof message.sdp === "string") {
      send(runner.ws, { type: "answer", session: session.id, seat: player.seat, peer: player.peer, sdp: message.sdp });
    }
  }

  function runnerMessage(message) {
    if (message.type === "start") return start();
    if (!session || message.session !== session.id) return;
    if (message.type === "stop") return stop();
    if (message.type === "stopped" && session.phase === "stopping") return reset();
    if (message.type === "error") return stop(String(message.reason ?? "The game runner failed.").slice(0, 200));
    if (message.type === "ready" && session.phase === "starting") {
      clearTimeout(cleanupTimer);
      session.phase = "streaming";
      return updateRoom();
    }
    if (message.type === "claim" || message.type === "leave") return playerMessage(runner, message);
    const visitor = seats.get(message.seat);
    if (session.phase !== "streaming" || !visitor?.peer || message.peer !== visitor.peer) return;
    if (message.type === "offer" && typeof message.sdp === "string") {
      send(visitor.ws, { type: "offer", session: session.id, peer: visitor.peer, sdp: message.sdp });
    }
    if (message.type === "peer_error") send(visitor.ws, { type: "peer_error", session: session.id });
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else {
        ws.alive = false;
        ws.ping();
      }
    }
  }, 5000);
  heartbeat.unref();
  server.on("close", () => {
    clearInterval(heartbeat);
    wss.close();
  });

  server.on("upgrade", (req, socket, head) => {
    const isRunner = req.url === "/signal/runner";
    if (isRunner) {
      const protocols = req.headers["sec-websocket-protocol"]?.split(",").map(value => value.trim());
      if (!localRunner(req) || req.headers.origin !== `http://${req.headers.host}` ||
          protocols?.length !== 2 || protocols[0] !== "fifa-runner" || protocols[1] !== runnerKey) {
        return socket.destroy();
      }
    } else if (req.url !== "/signal/room" || !lanPlayer(req, playerHost) ||
               req.headers.origin !== `https://${playerHost}`) {
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on("error", () => ws.terminate());
      if (isRunner && runner) return ws.close(1008, "A runner is already online.");
      let visitor;
      ws.alive = true;
      ws.on("pong", () => { ws.alive = true; });
      const helloTimeout = isRunner ? undefined : setTimeout(() => ws.close(1008, "Room handshake timed out."), 5000);
      if (isRunner) {
        runner = { ws };
        reason = undefined;
        snapshot();
      }
      ws.on("message", (raw, binary) => {
        let message;
        try { message = JSON.parse(raw); } catch { return ws.close(1007); }
        if (binary || !message || typeof message !== "object") return ws.close(1007);
        if (isRunner) return runnerMessage(message);
        if (!visitor) {
          if (message.type !== "hello") return ws.close(1008);
          clearTimeout(helloTimeout);
          visitor = registerVisitor(ws, message.credential);
        } else if (visitor.ws === ws) {
          playerMessage(visitor, message);
        }
      });
      ws.on("close", () => {
        clearTimeout(helloTimeout);
        if (isRunner) {
          runner = null;
          reason = "Windows runner disconnected.";
          reset();
        } else if (visitor) {
          removeVisitor(visitor, ws);
        }
      });
    });
  });
}
