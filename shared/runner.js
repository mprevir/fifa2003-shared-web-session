import {codes, neutral, readPad, valid} from "./controls.js";
import {socket, localDescription} from "./peer.js";
import {seatControls} from "./seats.js";

const peers = new Map();
const runnerKey = new URLSearchParams(location.hash.slice(1)).get("key");
const arm = document.querySelector("#arm");
const game = document.querySelector("#game");
const events = document.querySelector("#events");
const status = document.querySelector("#status");
const showSeats = seatControls(send, leaveLocalSeat);
let ws, run, mixer, room, localPlayer;
let localInput = neutral();
const log = text => {
  events.textContent += new Date().toLocaleTimeString()+" "+text+"\n";
  events.scrollTop = events.scrollHeight;
};
function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function report(type, extra={}) {
  if (run) send({type,session:run.id,...extra});
}
function apply(player, s) {
  if (!run?.activeCanvas) return;
  const win = run.frame.contentWindow;
  if (player.seat === 2) win.setSharedPad(s);
  else {
    const canvas = win.document.getElementById("canvas");
    codes.forEach((code,i)=>{
      if ((s.keys ^ player.state.keys) & (1<<i)) {
        const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : code === "Space" ? " " : code;
        canvas.dispatchEvent(new win.KeyboardEvent(s.keys & (1<<i) ? "keydown":"keyup",{code,key,bubbles:true,cancelable:true}));
      }
    });
    const rect = run.activeCanvas.getBoundingClientRect();
    const mouse = type => canvas.dispatchEvent(new win.MouseEvent(type,{
      clientX:rect.left+s.x*Math.max(0,rect.width-1),clientY:rect.top+s.y*Math.max(0,rect.height-1),
      bubbles:true,cancelable:true,button:0,buttons:Number(s.down)
    }));
    if (player.state.x !== s.x || player.state.y !== s.y) mouse("mousemove");
    if (player.state.down !== s.down) mouse(s.down ? "mousedown":"mouseup");
  }
  player.state = s;
}
function releaseInput(player) {
  const {x,y} = player.state;
  apply(player, {...neutral(),x,y});
}
function releaseLocalInput() {
  localInput = {...neutral(),x:localInput.x,y:localInput.y};
  if (localPlayer) releaseInput(localPlayer);
}
function leaveLocalSeat() {
  releaseLocalInput();
  localPlayer = null;
  localInput = neutral();
}
function canPlayLocally() {
  return localPlayer && run?.ready && document.activeElement === run.output &&
    document.hasFocus() && !document.hidden;
}
function sampleLocalInput() {
  if (!canPlayLocally()) return;
  const state = {...neutral(),keys:localInput.keys,x:localInput.x,y:localInput.y,down:localInput.down};
  const pad = Array.from(navigator.getGamepads?.() ?? []).find(pad => pad?.connected);
  readPad(state,pad,localPlayer.seat);
  apply(localPlayer,state);
}
function bindGameInput(output) {
  for (const event of ["keydown","keyup"]) output.addEventListener(event,e=>{
    const i = codes.indexOf(e.code);
    if (!canPlayLocally() || i < 0 || (event === "keydown" && (e.metaKey || e.altKey))) return;
    e.preventDefault();
    if (event === "keydown") {
      if (!e.repeat) localInput.keys |= 1<<i;
    } else {
      localInput.keys &= ~(1<<i);
    }
    sampleLocalInput();
  });
  for (const event of ["pointermove","pointerdown","pointerup"]) output.addEventListener(event,e=>{
    if (!localPlayer || !e.isPrimary || (event !== "pointermove" && e.button !== 0)) return;
    if (event === "pointerdown") output.focus();
    if (!canPlayLocally() || localPlayer.seat !== 1) return;
    const rect = output.getBoundingClientRect();
    localInput.x = Math.min(1,Math.max(0,(e.clientX-rect.left)/rect.width));
    localInput.y = Math.min(1,Math.max(0,(e.clientY-rect.top)/rect.height));
    if (event === "pointerdown") {
      output.setPointerCapture(e.pointerId);
      localInput.down = true;
    }
    if (event === "pointerup") localInput.down = false;
    sampleLocalInput();
  });
  output.addEventListener("blur",releaseLocalInput);
  output.addEventListener("pointercancel",releaseLocalInput);
}
function remove(seat) {
  const peer = peers.get(seat);
  if (!peer) return;
  peers.delete(seat);
  releaseInput(peer);
  peer.pc.close();
}
function cleanup() {
  if (!run) return;
  leaveLocalSeat();
  for (const seat of peers.keys()) remove(seat);
  clearInterval(run.timer);
  for (const source of run.sources) source.disconnect();
  run.stream.getTracks().forEach(track=>track.stop());
  run.frame.remove();
  run.output.remove();
  run = null;
}
function start(id) {
  const frame = document.createElement("iframe");
  // The parent canvas is the input surface. Boxedwine receives only seat-mapped input.
  frame.inert = true;
  frame.setAttribute("aria-hidden","true");
  frame.allow = "autoplay; gamepad 'none'";
  const output = document.createElement("canvas");
  output.width = 960;
  output.height = 720;
  output.tabIndex = 0;
  output.setAttribute("aria-label","FIFA game picture");
  bindGameInput(output);
  const ctx = output.getContext("2d",{alpha:false});
  const stream = output.captureStream(30);
  const audio = mixer.createMediaStreamDestination();
  stream.addTrack(audio.stream.getAudioTracks()[0]);
  const current = run = {id,frame,output,stream,audio,sources:[],boot:false,ready:false};
  // Boxedwine parses the raw query and needs literal colons in the Wine override and paths.
  frame.src = "/shared-game.html?root=boxedwine.zip&app=fifa325-pad.zip" +
    "&env=%22WINEDLLOVERRIDES:dinput,xinput1_4=n,b%22&p=c:/files/fifa2003.exe&w=c:/files" +
    "&registry=gl&storage=memory&rootfs=indexeddb&resolution=1280x1024";
  game.append(frame,output);
  log("Starting Boxedwine");
  let sampled = 0;
  current.timer = setInterval(()=>{
    const doc = frame.contentDocument;
    if (!doc || !current.boot) return;
    const layers = [...doc.querySelectorAll(".emscripten_border canvas")].filter(c=>
      c.width && c.height && c.offsetWidth && frame.contentWindow.getComputedStyle(c).visibility !== "hidden");
    if (!layers.length) return;
    const active = current.activeCanvas = layers.at(-1);
    const height = Math.round(output.width * active.height / active.width);
    if (height && output.height !== height) output.height = height;
    ctx.fillStyle = "black";
    ctx.fillRect(0,0,output.width,output.height);
    for (const c of layers) ctx.drawImage(c,0,0,output.width,output.height);
    // The capture tracks are live once the mixer and the first game frame are available.
    // FIFA can open its sound device later in startup.
    if (!current.ready && mixer.state === "running" && performance.now()-sampled > 250) {
      sampled = performance.now();
      const pixels = ctx.getImageData(0,Math.floor(output.height/2),output.width,1).data;
      if (pixels.some((value,i)=>i%4 !== 3 && value>30)) {
        current.ready = true;
        log("Game picture and both capture tracks available");
        report("ready");
      }
    }
    for (const p of peers.values()) if (p.active && performance.now()-p.last>400) {
      releaseInput(p);
      p.active = false;
    }
    sampleLocalInput();
  },1000/30);
}
window.gameAudio = (win, stream, context) => {
  if (win !== run?.frame.contentWindow) return;
  const source = mixer.createMediaStreamSource(stream);
  source.connect(run.audio);
  source.connect(mixer.destination);
  run.sources.push(source);
  context.resume().catch(e=>log(e.message));
  log("Game audio attached");
};
window.gameFailed = (win, reason) => {
  if (win !== run?.frame.contentWindow) return;
  log(reason);
  report("error",{reason});
};
window.gameBoot = win => {
  if (win === run?.frame.contentWindow) {
    run.boot=true;
    win.document.querySelector("#canvas").inert = true;
    log("Game filesystem ready");
  }
};
async function offer(m) {
  remove(m.seat);
  const pc = new RTCPeerConnection();
  const peer = {pc,id:m.peer,seat:m.seat,state:neutral(),seq:-1};
  peers.set(m.seat,peer);
  run.stream.getTracks().forEach(track=>pc.addTrack(track,run.stream));
  const dc = pc.createDataChannel("controls",{ordered:false,maxPacketLifeTime:150});
  dc.onmessage = e=>{
    if (peers.get(m.seat)!==peer || typeof e.data!=="string" || e.data.length>768) return;
    let s;
    try { s=JSON.parse(e.data); } catch {return;}
    if (!valid(s) || s.seq<=peer.seq) return;
    peer.seq=s.seq;
    peer.last=performance.now();
    peer.active=true;
    apply(peer,s);
  };
  dc.onclose = ()=>{ if (peers.get(m.seat)===peer) releaseInput(peer); };
  const sdp = await localDescription(pc,await pc.createOffer());
  if (peers.get(m.seat)===peer) report("offer",{seat:m.seat,peer:m.peer,sdp});
}
function showRoom(next) {
  const seat = next?.phase === "streaming" ? next.seat : null;
  const previousSeat = room?.phase === "streaming" ? room.seat : null;
  if (seat !== previousSeat) {
    leaveLocalSeat();
    if (seat) localPlayer = {seat,state:neutral()};
  }
  room = next;
  showSeats(room);
  const phase = room?.phase;
  arm.textContent = !room ? "Enable runner and audio" : phase === "idle" ? "Start session" : "End session";
  arm.disabled = phase === "stopping";
  status.textContent = (room?.seat ? "Player " + room.seat + " · " : "") + ({
    idle:"Ready to start.", starting:"Starting FIFA…", stopping:"Ending session…",
    streaming:localPlayer ? "Click the picture to play." : "FIFA is running. Keep this window visible.",
  }[phase] ?? "Enable the runner to launch FIFA.");
  if (room?.reason) status.textContent += " " + room.reason;
}

arm.onclick = async ()=>{
  arm.disabled=true;
  if (room) {
    if (room.phase === "idle") send({type:"start"});
    else {
      leaveLocalSeat();
      send({type:"stop",session:room.session});
    }
    return;
  }
  try {
    mixer ??= new AudioContext();
    await mixer.resume();
    ws=socket("/signal/runner",runnerKey ? ["fifa-runner",runnerKey] : undefined);
  } catch (err) {
    arm.disabled=false;
    return log(err.message);
  }
  ws.onopen=()=>{
    log("Runner online");
    send({type:"start"});
  };
  ws.onclose=e=>{
    cleanup();
    showRoom(null);
    log(e.reason || "Offline. Use the Windows runner URL from the host terminal and enable it again.");
  };
  ws.onmessage=async e=>{
    const m=JSON.parse(e.data);
    try {
      if (m.type==="status") return showRoom(m);
      if (m.type==="start" && !run) return await start(m.session);
      if (m.type==="stop" && (!run || m.session===run.id)) {
        cleanup();
        send({type:"stopped",session:m.session});
        return log("Available");
      }
      if (m.session!==run?.id) return;
      if (m.type==="peer") await offer(m);
      const p=peers.get(m.seat);
      if (p && p.id===m.peer) {
        if (m.type==="answer") await p.pc.setRemoteDescription({type:"answer",sdp:m.sdp});
        if (m.type==="leave") remove(m.seat);
      }
    } catch (err) {
      log(err.message);
      if (m.type==="start" && (!run || run.id===m.session) && ws.readyState===WebSocket.OPEN) {
        ws.send(JSON.stringify({type:"error",session:m.session,reason:err.message}));
      }
      if (m.type==="peer" && peers.get(m.seat)?.id===m.peer) {
        report("peer_error",{seat:m.seat,peer:m.peer});
        remove(m.seat);
      }
    }
  };
};
window.addEventListener("blur",releaseLocalInput);
window.addEventListener("gamepaddisconnected",releaseLocalInput);
document.addEventListener("visibilitychange",()=>{if (document.hidden) releaseLocalInput();});
window.addEventListener("pagehide",()=>{
  cleanup();
  ws?.close();
});
