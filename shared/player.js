import {codes,neutral,readPad} from "./controls.js";
import {socket,localDescription} from "./peer.js";
import {seatControls} from "./seats.js";
const el = id=>document.getElementById(id);
const video=el("screen"), status=el("status"), sound=el("sound");
let ws, seat, session, pc, channel, keys=0, x=.5, y=.5, down=false;
let seq=0, signature="", last=0, padIndex, enabled=false;
let leavingSeat = false;
const showSeats = seatControls(send, () => {
  leavingSeat = true;
  clearPeer();
});
const say = message => status.textContent=message;
function transmit(force=false) {
  if (channel?.readyState!=="open" || channel.bufferedAmount>2048) return;
  const s=neutral();
  if (enabled && !document.hidden && document.hasFocus()) {
    Object.assign(s,{keys,x,y,down});
    const pads=Array.from(navigator.getGamepads?.() || []);
    const pad=pads[padIndex] || pads.find(p=>p?.connected);
    padIndex=pad?.index;
    readPad(s,pad,seat);
  }
  const next=JSON.stringify(s), now=performance.now();
  if (!force && next===signature && now-last<90) return;
  channel.send(JSON.stringify({...s,seq:++seq}));
  signature=next;
  last=now;
}
function release() {
  enabled=false; keys=0; down=false; padIndex=undefined;
  transmit(true);
}
function clearPeer() {
  release();
  channel=null;
  pc?.close();pc=null;
  video.srcObject=null;sound.hidden=true;
  el("stats").textContent="";
  el("reconnect").hidden=true;
}
async function play() {
  const stream=video.srcObject;
  try {await video.play();if (video.srcObject===stream) sound.hidden=true;}
  catch {if (video.srcObject===stream) sound.hidden=false;}
}

function send(message) {
  if (ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function streamFailed(message) {
  say(message);
  el("reconnect").hidden=false;
}

async function receiveOffer(m) {
  if (!seat || leavingSeat || session!==m.session) return;
  clearPeer();
  const current=pc=new RTCPeerConnection();
  const failed = message => {
    if (pc===current) streamFailed(message);
  };
  current.ontrack=e=>{
    if (pc===current) {video.srcObject=e.streams[0];play();}
  };
  current.ondatachannel=e=>{
    if (pc!==current) return;
    const controls=channel=e.channel;
    controls.onopen=()=>{
      if (channel!==controls) return;
      enabled=document.hasFocus();transmit(true);
    };
  };
  current.onconnectionstatechange=()=>{
    if (current.connectionState==="failed") failed("The match stream disconnected.");
  };
  try {
    await current.setRemoteDescription({type:"offer",sdp:m.sdp});
    const sdp=await localDescription(current,await current.createAnswer());
    if (current===pc) send({type:"answer",session,peer:m.peer,sdp});
  } catch (err) {failed(err.message);}
}

function showRoom(state) {
  const phase=state?.phase;
  const playing=!!state?.seat && phase==="streaming";
  showSeats(state);
  el("match").hidden=!playing;
  if (!state) return;

  const text=[];
  if (state.seat) text.push(`Player ${state.seat}`);
  if (phase==="offline") text.push("Windows runner offline. Enable it on the host PC.");
  if (phase==="idle") text.push("Waiting for the operator to start FIFA.");
  if (phase==="starting") text.push("Starting FIFA…");
  if (phase==="stopping") text.push("Ending session…");
  if (phase==="streaming") {
    if (playing) text.push("FIFA is running.");
    else text.push(Object.values(state.seats).includes("open") ? "Choose a seat." : "Both seats are taken.");
  }
  if (state.reason) text.push(state.reason);
  say(text.join(" · "));
  if (playing) {
    el("guide").textContent=seat===1
      ? "Click the picture to focus. Use the mouse for menus and assign the keyboard and gamepad to opposite teams at Select Sides."
      : "Click the picture to focus. Use arrows to move, S to pass, D to shoot, A to lob or tackle, and W for a through ball. If you arrived after kickoff, have Player 1 assign your controller at Select Sides before the next match.";
  }
}

function inviteRoom() {
  const key="fifa-seat";
  let credential, retry, leaving=false;
  try {credential=sessionStorage.getItem(key);} catch {}
  function connect() {
    const connection=ws=socket("/signal/room");
    connection.onopen=()=>send({type:"hello",credential});
    connection.onmessage=e=>{
      if (ws!==connection) return;
      const m=JSON.parse(e.data);
      if (m.type==="hello") {
        credential=m.credential;
        try {sessionStorage.setItem(key,credential);} catch {}
      }
      if (m.type==="status") {
        if (session!==m.session || seat!==m.seat) {
          clearPeer();
          leavingSeat = false;
        }
        session=m.session;seat=m.seat;
        showRoom(m);
      }
      if (m.type==="offer") receiveOffer(m);
      if (m.type==="peer_error" && seat && !leavingSeat && m.session===session) {
        streamFailed("Could not connect to the match stream.");
      }
    };
    connection.onclose=e=>{
      if (ws!==connection) return;
      clearPeer();ws=null;session=null;seat=null;leavingSeat=false;showRoom(null);
      if (leaving) return;
      if (e.code===1008) return say(e.reason || "Room connection closed. Reload to try again.");
      say("Reconnecting to the room…");
      retry=setTimeout(connect,1000);
    };
  }
  el("reconnect").onclick=()=>ws?.close();
  window.addEventListener("pagehide",()=>{leaving=true;clearTimeout(retry);});
  window.addEventListener("pageshow",event=>{
    if (event.persisted) {leaving=false;connect();}
  });
  connect();
}

inviteRoom();
sound.onclick=()=>{play();video.focus();};
for (const event of ["keydown","keyup"]) window.addEventListener(event,e=>{
  const i=codes.indexOf(e.code);
  if (channel?.readyState!=="open" || i<0 || e.metaKey || e.altKey || (e.target.tagName==="BUTTON" && ["Enter","Space"].includes(e.code))) return;
  enabled=true;e.preventDefault();
  if(event==="keydown") keys|=1<<i; else keys&=~(1<<i);
  transmit();
});
function pointer(e) {
  if (seat!==1 || channel?.readyState!=="open") return;
  const rect=video.getBoundingClientRect();
  x=Math.min(1,Math.max(0,(e.clientX-rect.left)/rect.width));
  y=Math.min(1,Math.max(0,(e.clientY-rect.top)/rect.height));
  if(e.type==="pointerdown") {video.setPointerCapture(e.pointerId);video.focus();down=true;}
  if(e.type==="pointerup") down=false;
  enabled=true;transmit();
}
for(const event of ["pointerdown","pointerup","pointermove"]) video.addEventListener(event,pointer);
video.addEventListener("pointercancel",release);
window.addEventListener("blur",release);
window.addEventListener("focus",()=>{enabled=true;});
window.addEventListener("gamepadconnected",()=>{enabled=document.hasFocus();});
window.addEventListener("gamepaddisconnected",release);
document.addEventListener("visibilitychange",()=>{if(document.hidden) release();else enabled=document.hasFocus();});
window.addEventListener("pagehide",()=>{release();ws?.close();});
setInterval(transmit,16);
setInterval(async ()=>{
  const current=pc;
  if (current?.connectionState!=="connected") return;
  const reports=await current.getStats();
  if (current!==pc) return;
  const values=[];
  reports.forEach(r=>{
    if(r.type==="candidate-pair" && r.nominated && Number.isFinite(r.currentRoundTripTime))
      values.push("RTT "+Math.round(1000*r.currentRoundTripTime)+" ms");
    if(r.type==="inbound-rtp" && r.kind==="video")
      values.push((r.framesPerSecond??0)+" fps · "+r.framesDecoded+" decoded · "+r.framesDropped+" dropped");
  });
  el("stats").textContent=values.join(" · ");
},1000);
