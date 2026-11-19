import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { WebSocket } from "ws";
import { attachRoom } from "./room.mjs";

const runnerKey = "test-runner-key";
const playerHost = "192.0.2.1:18444";
const proxyHeaders = { host: playerHost, "x-forwarded-for": "192.0.2.2", "x-forwarded-proto": "https" };

async function roomFixture(t, { reconnectMs = 500, startupMs = 2000, nativeGame = { start() {}, stop() {} } } = {}) {
  const server = createServer();
  attachRoom(server, { runnerKey, playerHost, reconnectMs, startupMs, nativeGame });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = `127.0.0.1:${server.address().port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });

  function socket(path, protocols, headers) {
    const origin = headers?.host ? `https://${headers.host}` : `http://${address}`;
    const ws = new WebSocket(`ws://${address}${path}`, protocols, { origin, headers });
    sockets.push(ws);
    const pending = [];
    let notify;
    ws.on("error", () => {});
    ws.on("message", raw => {
      pending.push(JSON.parse(raw));
      notify?.();
    });
    return {
      ws,
      send: message => ws.send(JSON.stringify(message)),
      async next(type, predicate = () => true) {
        for (;;) {
          const index = pending.findIndex(message => message.type === type && predicate(message));
          if (index >= 0) return pending.splice(0, index + 1).at(-1);
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Missing ${type}: ${JSON.stringify(pending)}`)), 3000);
            notify = () => { clearTimeout(timeout); resolve(); };
          });
        }
      },
    };
  }

  return {
    socket,
    async visitor(credential) {
      const client = socket("/signal/room", undefined, proxyHeaders);
      await once(client.ws, "open");
      client.send({ type: "hello", credential });
      client.credential = (await client.next("hello")).credential;
      return client;
    },
    async runner() {
      const client = socket("/signal/runner", ["fifa-runner", runnerKey]);
      await client.next("status", m => m.phase === "idle");
      return client;
    },
  };
}

const openSeats = { 1: "open", 2: "open" };
const claim = (client, session, seat) => client.send({ type: "claim", session, seat });
const leave = (client, session, seat) => client.send({ type: "leave", session, seat });

test("a native viewer keeps its seat through capture loss and returns to the lobby when FIFA exits", async t => {
  let exit;
  let stopped = false;
  const room = await roomFixture(t, { nativeGame: {
    async start(onExit) { exit = onExit; },
    stop() { stopped = true; },
  } });
  const viewer = room.socket("/signal/room");
  await once(viewer.ws, "open");
  viewer.send({ type: "hello" });
  assert.equal((await viewer.next("status")).phase, "offline");

  const runner = await room.runner();
  runner.send({ type: "start" });
  const { session } = await runner.next("start");
  runner.send({ type: "ready", session });
  await viewer.next("status", status => status.phase === "streaming");
  claim(viewer, session, 1);
  const original = await runner.next("peer");
  assert.equal(original.seat, 1);

  runner.send({ type: "capture_lost", session });
  await runner.next("leave", message => message.peer === original.peer);
  const waiting = await viewer.next("status", status => status.phase === "starting" && status.seat === 1);
  assert.equal(waiting.session, session);
  assert.equal(stopped, false);
  runner.send({ type: "ready", session });
  const replacement = await runner.next("peer");
  assert.equal(replacement.seat, 1);
  assert.notEqual(replacement.peer, original.peer);

  exit("FIFA exited (0).");
  await runner.next("stop");
  assert.equal(stopped, true);
  runner.send({ type: "stopped", session });
  const idle = await viewer.next("status", status => status.phase === "idle" && status.reason);
  assert.equal(idle.reason, "FIFA exited (0).");
  assert.deepEqual(idle.seats, openSeats);
});

test("the runner starts and stops a session with independent, explicit seat claims", async t => {
  const room = await roomFixture(t);
  const first = await room.visitor();
  await first.next("status", m => m.phase === "offline");
  const runner = await room.runner();
  first.send({ type: "host" });
  first.send({ type: "start" });
  first.send({ type: "wait" });
  const second = await room.visitor();
  assert.equal((await second.next("status")).phase, "idle");
  runner.send({ type: "start" });
  const { session } = await runner.next("start");
  assert.deepEqual((await first.next("status", m => m.phase === "starting")).seats, openSeats);
  runner.send({ type: "ready", session });
  assert.deepEqual((await runner.next("status", m => m.phase === "streaming")).seats, openSeats);
  const late = await room.visitor();
  assert.deepEqual((await late.next("status")).seats, openSeats);

  claim(first, session, 1);
  claim(late, session, 1);
  const [remote, local] = await Promise.all([first, late].map(client =>
    client.next("status", m => m.seats[1] === "occupied")));
  assert.deepEqual([remote.seat, local.seat].sort(), [1, null]);
  const winner = remote.seat ? first : late;
  const loser = remote.seat ? late : first;
  claim(loser, session, 2);
  await loser.next("status", m => m.seat === 2);
  await runner.next("status", m => m.seats[1] === "occupied" && m.seats[2] === "occupied");
  claim(winner, session, 2);
  await winner.next("status", m => m.seat === 1);
  leave(winner, session, 1);
  await second.next("status", m => m.session === session && m.seats[1] === "open" && m.seats[2] === "occupied");
  claim(second, session, 1);
  await second.next("status", m => m.seat === 1);

  second.send({ type: "stop", session });
  leave(loser, session, 2);
  await second.next("status", m => m.phase === "streaming" && m.seat === 1 && m.seats[2] === "open");
  claim(first, session, 2);
  await first.next("status", m => m.seat === 2);
  runner.send({ type: "stop", session });
  await runner.next("stop", m => m.session === session);
  for (const client of [first, second]) {
    const stopping = await client.next("status", m => m.phase === "stopping");
    assert.equal(stopping.seat, null);
    assert.deepEqual(stopping.seats, openSeats);
  }
  runner.send({ type: "stopped", session });
  await runner.next("status", m => m.phase === "idle");
  runner.send({ type: "start" });
  const next = await runner.next("start");
  assert.notEqual(next.session, session);
  claim(first, session, 1);
  runner.send({ type: "ready", session: next.session });
  assert.deepEqual((await first.next("status", m => m.session === next.session && m.phase === "streaming")).seats,
    openSeats);
});

test("a dropped Player 1 seat reconnects or expires independently of the session", async t => {
  const room = await roomFixture(t);
  const runner = await room.runner();
  const first = await room.visitor();
  const second = await room.visitor();
  runner.send({ type: "start" });
  const { session } = await runner.next("start");
  claim(first, session, 1);
  await first.next("status", m => m.seat === 1 && m.phase === "starting");
  runner.send({ type: "ready", session });
  const originalPeer = await runner.next("peer", m => m.seat === 1);
  claim(second, session, 2);
  await second.next("status", m => m.seat === 2);
  first.ws.close();
  assert.equal((await runner.next("leave", m => m.seat === 1)).peer, originalPeer.peer);
  await second.next("status", m => m.seats[1] === "reconnecting");
  assert.equal((await runner.next("status", m => m.seats[1] === "reconnecting")).seat, null);
  const returning = await room.visitor(first.credential);
  assert.equal(returning.credential, first.credential);
  await returning.next("status", m => m.seat === 1);
  const nextPeer = await runner.next("peer", m => m.seat === 1);
  assert.notEqual(nextPeer.peer, originalPeer.peer);
  returning.send({ type: "answer", session, peer: originalPeer.peer, sdp: "stale" });
  returning.send({ type: "answer", session, peer: nextPeer.peer, seat: 2, sdp: "current" });
  const answer = await runner.next("answer");
  assert.equal(answer.seat, 1);
  assert.equal(answer.sdp, "current");

  returning.ws.close();
  await second.next("status", m => m.seats[1] === "reconnecting");
  const expired = await second.next("status", m => m.session === session && m.seats[1] === "open");
  assert.equal(expired.seat, 2);
  assert.equal(expired.phase, "streaming");
  leave(second, session, 2);
  await runner.next("status", m => m.session === session && m.seats[1] === "open" && m.seats[2] === "open");
  claim(second, session, 2);
  await second.next("status", m => m.seat === 2);
  leave(second, session, 2);
  await runner.next("status", m => m.session === session && !m.seat && m.seats[2] === "open");
});

test("runner authorization, failed startup, timeout, and runner disconnect", async t => {
  const room = await roomFixture(t, { startupMs: 500 });
  const runner = await room.runner();
  const invalid = room.socket("/signal/room/other", undefined, proxyHeaders);
  const legacy = room.socket("/signal/player/1");
  const unauthorized = room.socket("/signal/runner", ["fifa-runner", "wrong"]);
  const proxied = room.socket("/signal/runner", ["fifa-runner", runnerKey], proxyHeaders);
  const rejected = await Promise.all([invalid, legacy, unauthorized, proxied].map(client =>
    new Promise(resolve => client.ws.once("close", resolve))));
  assert.deepEqual(rejected, [1006, 1006, 1006, 1006]);
  const player = await room.visitor();
  runner.send({ type: "start" });
  const failed = await runner.next("start");
  runner.send({ type: "error", session: failed.session, reason: "Startup failure" });
  await runner.next("stop");
  runner.send({ type: "ready", session: failed.session });
  runner.send({ type: "stopped", session: failed.session });
  await player.next("status", m => m.phase === "idle" && m.reason === "Startup failure");

  runner.send({ type: "start" });
  const timedOut = await runner.next("start");
  await runner.next("stop", m => m.session === timedOut.session);
  runner.send({ type: "stopped", session: timedOut.session });
  await player.next("status", m => m.phase === "idle" && m.reason?.includes("timed out"));

  runner.send({ type: "start" });
  const active = await runner.next("start");
  runner.send({ type: "ready", session: active.session });
  await player.next("status", m => m.phase === "streaming");
  claim(player, active.session, 1);
  await player.next("status", m => m.seat === 1);
  runner.ws.close();
  const offline = await player.next("status", m => m.phase === "offline");
  assert.deepEqual(offline.seats, openSeats);
});
