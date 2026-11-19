import { localDescription, socket } from "./peer.js";

const key = new URLSearchParams(location.hash.slice(1)).get("key");
const sessionButton = document.querySelector("#session");
const share = document.querySelector("#share");
const status = document.querySelector("#status");
const preview = document.querySelector("#preview");
let ws, room, game;
const peers = new Map();

function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function report(type, extra = {}) {
  send({ type, session: game.id, ...extra });
}

function show(next) {
  room = next;
  sessionButton.disabled = room?.phase === "stopping";
  sessionButton.textContent = !room ? "Enable runner" : room.phase === "idle" ? "Start session" : "End session";
  share.hidden = room?.phase !== "starting" || !game || !!game.stream;
  status.textContent = room?.reason || ({
    idle: "Ready to start.",
    starting: game ? "Choose the FIFA window in the browser picker." : "Starting FIFA…",
    streaming: "FIFA is live. Keep the game window visible and use the host PC to play.",
    stopping: "Ending session…",
  }[room?.phase] ?? "Enable the runner to launch FIFA.");
}

function remove(seat) {
  peers.get(seat)?.pc.close();
  peers.delete(seat);
}

function clearCapture() {
  for (const seat of peers.keys()) remove(seat);
  preview.onloadeddata = null;
  game?.stream?.getTracks().forEach(track => track.stop());
  if (game) game.stream = undefined;
  preview.srcObject = null;
  preview.hidden = true;
}

function cleanup() {
  clearCapture();
  game = undefined;
}

share.onclick = async () => {
  const current = game;
  share.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: "window",
        width: { max: 1280 },
        height: { max: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
      monitorTypeSurfaces: "exclude",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
    });
    if (game !== current) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const [track] = stream.getVideoTracks();
    if (track?.getSettings().displaySurface !== "window") {
      throw new Error("Select the FIFA window from the Window tab.");
    }
    track.contentHint = "motion";
    track.addEventListener("ended", () => {
      if (game !== current || current.stream !== stream) return;
      clearCapture();
      report("capture_lost");
    }, { once: true });
    current.stream = stream;
    preview.hidden = false;
    preview.onloadeddata = () => {
      preview.onloadeddata = null;
      if (game === current && track.readyState === "live") report("ready");
    };
    preview.srcObject = stream;
    share.hidden = true;
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    if (game === current) status.textContent = error.message;
  } finally {
    share.disabled = false;
  }
};

async function offer(message) {
  remove(message.seat);
  const pc = new RTCPeerConnection();
  const peer = { pc, id: message.peer };
  peers.set(message.seat, peer);
  for (const track of game.stream.getTracks()) pc.addTrack(track, game.stream);
  const sdp = await localDescription(pc, await pc.createOffer());
  if (peers.get(message.seat) === peer) {
    report("offer", { seat: message.seat, peer: message.peer, sdp });
  }
}

sessionButton.onclick = () => {
  if (room) {
    if (room.phase === "idle") send({ type: "start" });
    else send({ type: "stop", session: room.session });
    return;
  }
  sessionButton.disabled = true;
  try {
    ws = socket("/signal/runner", key ? ["fifa-runner", key] : undefined);
  } catch (error) {
    sessionButton.disabled = false;
    status.textContent = error.message;
    return;
  }
  ws.onopen = () => send({ type: "start" });
  ws.onclose = event => {
    cleanup();
    show(null);
    status.textContent = event.reason || "Runner disconnected. Enable it to start again.";
  };
  ws.onmessage = async event => {
    const message = JSON.parse(event.data);
    if (message.type === "status") return show(message);
    if (message.type === "start") {
      game = { id: message.session };
      return show(room);
    }
    if (message.type === "stop") {
      cleanup();
      return send({ type: "stopped", session: message.session });
    }
    if (message.session !== game?.id) return;
    try {
      if (message.type === "peer") {
        await offer(message);
        return;
      }
      const peer = peers.get(message.seat);
      if (peer?.id !== message.peer) return;
      if (message.type === "answer") await peer.pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
      if (message.type === "leave") remove(message.seat);
    } catch (error) {
      if (game?.id === message.session && peers.get(message.seat)?.id === message.peer) {
        status.textContent = error.message;
        report("peer_error", { seat: message.seat, peer: message.peer });
        remove(message.seat);
      }
    }
  };
};

window.addEventListener("pagehide", () => {
  cleanup();
  ws?.close();
});
