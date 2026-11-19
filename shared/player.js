import {socket,localDescription} from "./peer.js";
import {fullscreenControl} from "./fullscreen.js";
import {seatControls} from "./seats.js";
const el = id=>document.getElementById(id);
const video=el("screen"), status=el("status");
const gameArea=el("game-area");
let ws, seat, session, phase, pc;
let leavingSeat = false;
const showSeats = seatControls(send, () => {
  leavingSeat = true;
  clearPeer();
});
const say = message => status.textContent=message;
const showFullscreen = fullscreenControl(() => gameArea, say);
function clearPeer() {
  pc?.close();pc=null;
  video.srcObject=null;
  el("stats").textContent="";
  el("reconnect").hidden=true;
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
    if (pc===current) {video.srcObject=e.streams[0];}
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
  showFullscreen(playing);
  el("match").hidden=!playing;
  if (!state) return;

  const text=[];
  if (state.seat) text.push(`Player ${state.seat}`);
  if (phase==="offline") text.push("Windows runner offline. Enable it on the host PC.");
  if (phase==="idle") text.push("Waiting for the operator to start FIFA.");
  if (phase==="starting") text.push("Waiting for the host to share FIFA…");
  if (phase==="stopping") text.push("Ending session…");
  if (phase==="streaming") {
    if (playing) text.push("FIFA is running.");
    else text.push(Object.values(state.seats).includes("open") ? "Choose a seat." : "Both seats are taken.");
  }
  if (state.reason) text.push(state.reason);
  say(text.join(" · "));

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
        if (session!==m.session || seat!==m.seat || (phase==="streaming" && m.phase!=="streaming")) {
          clearPeer();
          leavingSeat = false;
        }
        session=m.session;seat=m.seat;phase=m.phase;
        showRoom(m);
      }
      if (m.type==="offer") receiveOffer(m);
      if (m.type==="peer_error" && seat && !leavingSeat && m.session===session) {
        streamFailed("Could not connect to the match stream.");
      }
    };
    connection.onclose=e=>{
      if (ws!==connection) return;
      clearPeer();ws=null;session=null;seat=null;phase=null;leavingSeat=false;showRoom(null);
      if (leaving) return;
      if (e.code===1008) return say(e.reason || "Room connection closed. Reload to try again.");
      say("Reconnecting to the room…");
      retry=setTimeout(connect,1000);
    };
  }
  el("reconnect").onclick=()=>ws?.close();
  window.addEventListener("pagehide",()=>{leaving=true;clearTimeout(retry);clearPeer();ws?.close();});
  window.addEventListener("pageshow",event=>{
    if (event.persisted) {leaving=false;connect();}
  });
  connect();
}

inviteRoom();
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
