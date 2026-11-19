import {codes, neutral, valid} from "./controls.js";
import {socket, localDescription} from "./peer.js";

const peers = new Map();
const runnerKey = new URLSearchParams(location.hash.slice(1)).get("key");
let ws, run, mixer;
const log = text => {
  events.textContent += new Date().toLocaleTimeString()+" "+text+"\n";
  events.scrollTop = events.scrollHeight;
};
function report(type, extra={}) {
  if (run && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type,session:run.id,...extra}));
}
function apply(peer, s) {
  const win = run?.frame.contentWindow;
  if (!win || !run.boot) return;
  if (peer.seat === 2) win.setSharedPad(s);
  else {
    const canvas = win.document.getElementById("canvas");
    codes.forEach((code,i)=>{
      if ((s.keys ^ peer.state.keys) & (1<<i)) {
        const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : code === "Space" ? " " : code;
        canvas.dispatchEvent(new win.KeyboardEvent(s.keys & (1<<i) ? "keydown":"keyup",{code,key,bubbles:true,cancelable:true}));
      }
    });
    const rect = canvas.getBoundingClientRect();
    const mouse = type => canvas.dispatchEvent(new win.MouseEvent(type,{
      clientX:rect.left+s.x*Math.max(0,rect.width-1),clientY:rect.top+s.y*Math.max(0,rect.height-1),
      bubbles:true,cancelable:true,button:0,buttons:Number(s.down)
    }));
    if (peer.state.x !== s.x || peer.state.y !== s.y) mouse("mousemove");
    if (peer.state.down !== s.down) mouse(s.down ? "mousedown":"mouseup");
  }
  peer.state = s;
}
function remove(seat) {
  const peer = peers.get(seat);
  if (!peer) return;
  peers.delete(seat);
  apply(peer, neutral());
  peer.pc.close();
}
function cleanup() {
  if (!run) return;
  for (const seat of peers.keys()) remove(seat);
  clearInterval(run.timer);
  for (const source of run.sources) source.disconnect();
  run.stream.getTracks().forEach(track=>track.stop());
  run.frame.remove();
  run = null;
}
async function start(id) {
  const frame = document.createElement("iframe");
  const output = document.createElement("canvas");
  output.width = 960;
  output.height = 720;
  const ctx = output.getContext("2d",{alpha:false});
  const stream = output.captureStream(30);
  const audio = mixer.createMediaStreamDestination();
  stream.addTrack(audio.stream.getAudioTracks()[0]);
  const current = run = {id,frame,stream,audio,sources:[],boot:false,ready:false};
  // Boxedwine parses the raw query and needs literal colons in the Wine override and paths.
  frame.src = "/shared-game.html?root=boxedwine.zip&app=fifa325-pad.zip" +
    "&env=%22WINEDLLOVERRIDES:dinput,xinput1_4=n,b%22&p=c:/files/fifa2003.exe&w=c:/files" +
    "&registry=gl&storage=memory&rootfs=indexeddb&resolution=1280x1024";
  frame.allow = "autoplay";
  document.querySelector("#game").append(frame);
  log("Starting Boxedwine");
  let sampled = 0;
  current.timer = setInterval(()=>{
    const doc = frame.contentDocument;
    if (!doc || !current.boot) return;
    const layers = [...doc.querySelectorAll(".emscripten_border canvas")].filter(c=>
      c.width && c.height && c.offsetWidth && frame.contentWindow.getComputedStyle(c).visibility !== "hidden");
    if (!layers.length) return;
    const active = layers.at(-1);
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
      apply(p,neutral());
      p.active = false;
    }
  },1000/30);
}
window.gameAudio = (win, stream, context) => {
  if (win !== run?.frame.contentWindow) return;
  const source = mixer.createMediaStreamSource(stream);
  source.connect(run.audio);
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
    win.focus();
    const canvas=win.document.querySelector("#canvas");
    canvas.tabIndex=0;
    canvas.focus();
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
  dc.onclose = ()=>{ if (peers.get(m.seat)===peer) apply(peer,neutral()); };
  const sdp = await localDescription(pc,await pc.createOffer());
  if (peers.get(m.seat)===peer) report("offer",{seat:m.seat,peer:m.peer,sdp});
}
arm.onclick = async ()=>{
  arm.disabled=true;
  try {
    mixer ??= new AudioContext();
    await mixer.resume();
    ws=socket("/signal/runner",runnerKey ? ["fifa-runner",runnerKey] : undefined);
  } catch (err) {
    arm.disabled=false;
    return log(err.message);
  }
  ws.onopen=()=>{if (!runnerKey) log("Runner online");};
  ws.onclose=e=>{
    cleanup();arm.disabled=false;
    log(e.reason || "Offline. Use the Windows runner URL from the host terminal and enable it again.");
  };
  ws.onmessage=async e=>{
    const m=JSON.parse(e.data);
    try {
      if (m.type==="runner_online") return log("Runner online");
      if (m.type==="start" && !run) return await start(m.session);
      if (m.type==="stop" && (!run || m.session===run.id)) {
        cleanup();
        ws.send(JSON.stringify({type:"stopped",session:m.session}));
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
