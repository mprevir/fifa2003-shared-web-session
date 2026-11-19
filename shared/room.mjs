import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { localRunner } from "./service.mjs";

const token = () => randomBytes(16).toString("base64url");

export function attachRoom(server, { roomId, runnerKey, reconnectMs, startupMs }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const visitors = new Set();
  const waiting = new Set();
  const seats = new Map();
  let runner, session, cleanupTimer, reason;

  function send(ws, message) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function snapshot() {
    const phase = session?.phase ?? (runner ? "idle" : "offline");
    const positions = new Map([...waiting].map((visitor, index) => [visitor, index + 1]));
    for (const visitor of visitors) {
      send(visitor.ws, {
        type: "status", phase, reason, session: session?.id,
        seat: visitor.seat, waiting: waiting.has(visitor),
        position: positions.get(visitor),
        hostAway: seats.has(1) && !seats.get(1).ws,
        guestAway: seats.has(2) && !seats.get(2).ws,
        full: seats.size === 2,
      });
    }
  }

  function assign(seat, visitor) {
    seats.set(seat, visitor);
    visitor.seat = seat;
    waiting.delete(visitor);
  }

  function assignGuest() {
    if (session?.phase !== "streaming" || seats.has(2)) return;
    const guest = waiting.values().next().value ?? [...visitors].find(visitor =>
      !visitor.seat && visitor.arrivedDuring === session.id);
    if (guest) assign(2, guest);
  }

  function connectPeer(visitor) {
    if (!visitor.ws || !visitor.seat || visitor.peer || session?.phase !== "streaming") return;
    visitor.peer = randomUUID();
    send(runner, { type: "peer", session: session.id, seat: visitor.seat, peer: visitor.peer });
  }

  function disconnectPeer(visitor) {
    if (!visitor.peer || !session) return;
    send(runner, { type: "leave", session: session.id, seat: visitor.seat, peer: visitor.peer });
    visitor.peer = null;
  }

  function updateRoom() {
    assignGuest();
    snapshot();
    for (const visitor of seats.values()) connectPeer(visitor);
  }

  function reset() {
    clearTimeout(cleanupTimer);
    for (const visitor of seats.values()) {
      clearTimeout(visitor.hold);
      visitor.seat = null;
      visitor.peer = null;
    }
    seats.clear();
    session = null;
    snapshot();
  }

  function stop(message) {
    if (!session || session.phase === "stopping") return;
    clearTimeout(cleanupTimer);
    reason = message;
    session.phase = "stopping";
    for (const visitor of seats.values()) disconnectPeer(visitor);
    send(runner, { type: "stop", session: session.id });
    snapshot();
    cleanupTimer = setTimeout(() => runner?.terminate(), 10000);
  }

  function start(visitor) {
    if (!runner || session) return snapshot();
    reason = undefined;
    session = { id: randomUUID(), phase: "starting" };
    assign(1, visitor);
    send(runner, { type: "start", session: session.id });
    cleanupTimer = setTimeout(() => stop("Game startup timed out."), startupMs);
    snapshot();
  }

  function registerVisitor(ws, credential) {
    const returning = [...seats.values()].find(visitor => visitor.token === credential);
    const visitor = returning ?? { token: token(), arrivedDuring: session?.id };
    if (returning) {
      clearTimeout(visitor.hold);
      disconnectPeer(visitor);
      const previous = visitor.ws;
      visitor.ws = ws;
      previous?.close(1008, "This seat was opened in another page.");
    } else {
      visitor.ws = ws;
    }
    visitors.add(visitor);
    send(ws, { type: "hello", credential: visitor.token });
    updateRoom();
    return visitor;
  }

  function removeVisitor(visitor, ws) {
    if (visitor.ws !== ws) return;
    visitors.delete(visitor);
    waiting.delete(visitor);
    visitor.ws = null;
    disconnectPeer(visitor);
    if (visitor.seat && session.phase !== "stopping") {
      visitor.hold = setTimeout(() => {
        if (visitor.seat === 1) return stop("Player 1 did not reconnect in time.");
        seats.delete(2);
        visitor.seat = null;
        updateRoom();
      }, reconnectMs);
    }
    snapshot();
  }

  function playerMessage(visitor, message) {
    if (message.type === "host" && !visitor.seat) return start(visitor);
    if (!visitor.seat && message.type === "wait" && (!session || session.phase === "starting")) {
      waiting.add(visitor);
      return snapshot();
    }
    if (!visitor.seat && message.type === "cancel_wait") {
      waiting.delete(visitor);
      visitor.arrivedDuring = undefined;
      return snapshot();
    }
    if (!visitor.seat && message.type === "join" && session?.phase === "streaming" && !seats.has(2)) {
      visitor.arrivedDuring = session.id;
      return updateRoom();
    }
    if (!session || message.session !== session.id || !visitor.seat) return;
    if (message.type === "stop" && visitor.seat === 1) return stop("Player 1 ended the session.");
    if (message.type === "answer" && session.phase === "streaming" && visitor.peer &&
        message.peer === visitor.peer && typeof message.sdp === "string") {
      send(runner, { type: "answer", session: session.id, seat: visitor.seat, peer: visitor.peer, sdp: message.sdp });
    }
  }

  function runnerMessage(message) {
    if (!session || message.session !== session.id) return;
    if (message.type === "stopped" && session.phase === "stopping") return reset();
    if (message.type === "error") return stop(String(message.reason ?? "The game runner failed.").slice(0, 200));
    if (message.type === "ready" && session.phase === "starting") {
      clearTimeout(cleanupTimer);
      session.phase = "streaming";
      return updateRoom();
    }
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
    const origin = req.headers.origin;
    const sameOrigin = origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
    if (!sameOrigin || (!isRunner && req.url !== `/signal/room/${roomId}`)) return socket.destroy();
    if (isRunner) {
      const protocols = req.headers["sec-websocket-protocol"]?.split(",").map(value => value.trim());
      if (!localRunner(req) || protocols?.length !== 2 || protocols[0] !== "fifa-runner" || protocols[1] !== runnerKey) {
        return socket.destroy();
      }
    }
    wss.handleUpgrade(req, socket, head, ws => {
      if (isRunner && runner) return ws.close(1008, "A runner is already online.");
      let visitor;
      ws.alive = true;
      ws.on("pong", () => { ws.alive = true; });
      ws.on("error", () => ws.terminate());
      const helloTimeout = isRunner ? undefined : setTimeout(() => ws.close(1008, "Room handshake timed out."), 5000);
      if (isRunner) {
        runner = ws;
        reason = undefined;
        send(ws, { type: "runner_online" });
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
