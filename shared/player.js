import {codes,neutral,readPad} from "./controls.js";
import {socket,localDescription} from "./peer.js";
const el = id=>document.getElementById(id);
const video=el("screen"), status=el("status"), sound=el("sound");
let ws, seat, session, pc, channel, keys=0, x=.5, y=.5, down=false;
let seq=0, signature="", last=0, padIndex, enabled=false;
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
  if (el("reconnect")) el("reconnect").hidden=true;
}
function buttons(phase) {
  document.querySelectorAll("[data-seat]").forEach(b=>b.disabled=!!ws);
  el("leave").hidden=!ws;
  el("start").hidden=!(seat===1 && phase==="idle");
  el("stop").hidden=!(seat===1 && ["starting","streaming"].includes(phase));
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
  if (el("reconnect")) el("reconnect").hidden=false;
}

async function receiveOffer(m) {
  if (!session || session!==m.session) return;
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
  const canWait=phase==="offline" || phase==="idle" || phase==="starting";
  const playing=!!state?.seat && phase==="streaming";
  el("start").hidden=phase!=="idle";
  el("wait").hidden=!canWait || !!state?.seat || state.waiting;
  el("cancel").hidden=!state?.waiting;
  el("join").hidden=phase!=="streaming" || !!state.seat || state.full;
  el("stop").hidden=state?.seat!==1 || !["starting","streaming"].includes(phase);
  el("match").hidden=!playing;
  if (!state) return;

  const text=[];
  if (state.seat) text.push(`Player ${state.seat}`);
  if (state.waiting) text.push(`Waiting · position ${state.position}`);
  if (phase==="offline") text.push("Windows runner offline. Enable it on the host PC.");
  if (phase==="idle" && !state.waiting) text.push("Host as Player 1 or wait for someone else to host.");
  if (phase==="starting") text.push("Starting FIFA…");
  if (phase==="stopping") text.push("Ending session…");
  if (phase==="streaming") {
    if (playing) text.push(state.full ? "Match active" : "Waiting for Player 2");
    else text.push(state.full ? "Match full" : "Player 2 is available");
  }
  if (state.hostAway) text.push("Player 1 reconnecting");
  if (state.guestAway) text.push("Player 2 reconnecting");
  if (state.reason) text.push(state.reason);
  say(text.join(" · "));
  if (playing) {
    el("guide").textContent=seat===1
      ? "Click the picture to focus. Use the mouse for menus and assign the keyboard and gamepad to opposite teams at Select Sides."
      : "Click the picture to focus. Use arrows to move, S to pass, D to shoot, A to lob or tackle, and W for a through ball. If you arrived after kickoff, have Player 1 assign your controller at Select Sides before the next match.";
  }
}

function inviteRoom() {
  const key="fifa-seat:"+location.pathname;
  let credential, retry, leaving=false;
  try {credential=sessionStorage.getItem(key);} catch {}
  function connect() {
    const connection=ws=socket("/signal"+location.pathname);
    connection.onopen=()=>send({type:"hello",credential});
    connection.onmessage=e=>{
      if (ws!==connection) return;
      const m=JSON.parse(e.data);
      if (m.type==="hello") {
        credential=m.credential;
        try {sessionStorage.setItem(key,credential);} catch {}
      }
      if (m.type==="status") {
        if (session!==m.session || seat!==m.seat || m.phase==="stopping") clearPeer();
        session=m.session;seat=m.seat;
        showRoom(m);
      }
      if (m.type==="offer") receiveOffer(m);
      if (m.type==="peer_error" && m.session===session) streamFailed("Could not connect to the match stream.");
    };
    connection.onclose=e=>{
      if (ws!==connection) return;
      clearPeer();ws=null;session=null;seat=null;showRoom(null);
      if (leaving) return;
      if (e.code===1008) return say(e.reason || "Room connection closed. Reload to try again.");
      say("Reconnecting to the room…");
      retry=setTimeout(connect,1000);
    };
  }
  el("start").onclick=()=>send({type:"host"});
  el("wait").onclick=()=>send({type:"wait"});
  el("cancel").onclick=()=>send({type:"cancel_wait"});
  el("join").onclick=()=>send({type:"join"});
  el("stop").onclick=()=>send({type:"stop",session});
  el("reconnect").onclick=()=>ws?.close();
  window.addEventListener("pagehide",()=>{leaving=true;clearTimeout(retry);});
  window.addEventListener("pageshow",event=>{
    if (event.persisted) {leaving=false;connect();}
  });
  connect();
}

function prototype() {
  document.querySelectorAll("[data-seat]").forEach(b=>b.onclick=()=>{
    seat=Number(b.dataset.seat);
    ws=socket("/signal/player/"+seat);
    buttons();
    ws.onclose=e=>{
      clearPeer();ws=null;session=null;seat=null;buttons();
      say(e.reason || "Disconnected. Choose a seat to join again.");
    };
    ws.onmessage=e=>{
      const m=JSON.parse(e.data);
      if (m.type==="status") {
        if (session!==m.session || m.phase==="stopping") clearPeer();
        session=m.session;
        buttons(m.phase);
        say("Player "+seat+" · "+m.phase+(m.reason ? " · "+m.reason:""));
      }
      if (m.type==="offer") receiveOffer(m);
    };
  });
  el("start").onclick=()=>send({type:"start"});
  el("stop").onclick=()=>send({type:"stop",session});
  el("leave").onclick=()=>ws.close();
}

if (el("wait")) inviteRoom();
else prototype();
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
