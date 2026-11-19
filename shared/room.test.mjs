import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { WebSocket } from "ws";
import { attachRoom } from "./room.mjs";

const roomId = "test-room";
const runnerKey = "test-runner-key";

async function roomFixture(t, { reconnectMs = 500, startupMs = 2000 } = {}) {
  const server = createServer();
  attachRoom(server, { roomId, runnerKey, reconnectMs, startupMs });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = `127.0.0.1:${server.address().port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });

  function socket(path, protocols, headers) {
    const ws = new WebSocket(`ws://${address}${path}`, protocols, { origin: `http://${address}`, headers });
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
      const client = socket(`/signal/room/${roomId}`);
      await once(client.ws, "open");
      client.send({ type: "hello", credential });
      client.credential = (await client.next("hello")).credential;
      return client;
    },
    async runner() {
      const client = socket("/signal/runner", ["fifa-runner", runnerKey]);
      await client.next("runner_online");
      return client;
    },
  };
}

test("invite queue, competing hosts, held seats, and cleanup", async t => {
  const room = await roomFixture(t);
  const first = await room.visitor();
  await first.next("status", m => m.phase === "offline");
  const runner = await room.runner();
  const second = await room.visitor();
  const host = await room.visitor();
  first.send({ type: "wait" });
  await first.next("status", m => m.position === 1);
  second.send({ type: "wait" });
  await second.next("status", m => m.position === 2);
  first.send({ type: "cancel_wait" });
  await second.next("status", m => m.position === 1);
  first.send({ type: "wait" });
  await first.next("status", m => m.position === 2);

  host.send({ type: "host" });
  const { session } = await runner.next("start");
  first.send({ type: "host" });
  await first.next("status", m => m.phase === "starting" && m.waiting);
  runner.send({ type: "ready", session });
  await host.next("status", m => m.phase === "streaming" && m.seat === 1);
  await second.next("status", m => m.seat === 2);
  const guestPeer = await runner.next("peer", m => m.seat === 2);
  const late = await room.visitor();
  await late.next("status", m => m.full && !m.seat);

  second.ws.close();
  const released = await runner.next("leave", m => m.seat === 2);
  assert.equal(released.peer, guestPeer.peer);
  await late.next("status", m => m.guestAway && m.full);
  const returning = await room.visitor(second.credential);
  await returning.next("status", m => m.seat === 2);
  const nextPeer = await runner.next("peer", m => m.seat === 2);
  assert.notEqual(nextPeer.peer, guestPeer.peer);
  returning.send({ type: "answer", session, peer: guestPeer.peer, sdp: "stale" });
  returning.send({ type: "answer", session, peer: nextPeer.peer, seat: 1, sdp: "current" });
  const answer = await runner.next("answer");
  assert.equal(answer.seat, 2);
  assert.equal(answer.sdp, "current");
  returning.send({ type: "stop", session });
  returning.ws.close();
  await first.next("status", m => m.seat === 2);
  await late.next("status", m => m.full && !m.guestAway);

  host.send({ type: "stop", session });
  await runner.next("stop", m => m.session === session);
  await first.next("status", m => m.phase === "stopping");
  runner.send({ type: "stopped", session });
  await first.next("status", m => m.phase === "idle" && !m.seat);
});

test("late arrivals, failure and timeout recovery, and host disconnect", async t => {
  const room = await roomFixture(t, { startupMs: 500 });
  const runner = await room.runner();
  const invalid = room.socket("/signal/room/other");
  const unauthorized = room.socket("/signal/runner", ["fifa-runner", "wrong"]);
  const proxied = room.socket("/signal/runner", ["fifa-runner", runnerKey], { "x-forwarded-for": "127.0.0.1" });
  const rejected = await Promise.all([invalid, unauthorized, proxied].map(client =>
    new Promise(resolve => client.ws.once("close", resolve))));
  assert.deepEqual(rejected, [1006, 1006, 1006]);

  const host = await room.visitor();
  const waiter = await room.visitor();
  waiter.send({ type: "wait" });
  await waiter.next("status", m => m.waiting);
  host.send({ type: "host" });
  const failed = await runner.next("start");
  runner.send({ type: "error", session: failed.session, reason: "Startup failure" });
  await runner.next("stop");
  runner.send({ type: "ready", session: failed.session });
  runner.send({ type: "stopped", session: failed.session });
  await waiter.next("status", m => m.phase === "idle" && m.reason === "Startup failure" && m.position === 1);
  waiter.send({ type: "cancel_wait" });
  await waiter.next("status", m => !m.waiting);

  host.send({ type: "host" });
  const timedOut = await runner.next("start");
  await runner.next("stop", m => m.session === timedOut.session);
  runner.send({ type: "stopped", session: timedOut.session });
  await host.next("status", m => m.phase === "idle" && m.reason?.includes("timed out"));

  waiter.send({ type: "host" });
  const active = await runner.next("start");
  runner.send({ type: "ready", session: active.session });
  await waiter.next("status", m => m.phase === "streaming" && m.seat === 1 && !m.full);
  const late = await room.visitor();
  await late.next("status", m => m.seat === 2);
  waiter.ws.close();
  await late.next("status", m => m.hostAway);
  const returning = await room.visitor(waiter.credential);
  await returning.next("status", m => m.seat === 1 && m.session === active.session);
  returning.ws.close();
  await runner.next("stop", m => m.session === active.session);
  runner.send({ type: "stopped", session: active.session });
  await late.next("status", m => m.phase === "idle" && m.reason?.includes("did not reconnect"));
  runner.ws.close();
  await late.next("status", m => m.phase === "offline");
});
