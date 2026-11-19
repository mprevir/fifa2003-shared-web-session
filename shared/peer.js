// LAN-only, non-trickle ICE. Each SDP carries all collected host candidates.
export async function localDescription(pc, description) {
  await pc.setLocalDescription(description);
  if (pc.iceGatheringState !== "complete") await new Promise((resolve,reject)=>{
    const done = error => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange",check);
      error ? reject(error) : resolve();
    };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    const timer = setTimeout(()=>done(new Error("LAN candidate gathering timed out")),10000);
    pc.addEventListener("icegatheringstatechange",check);
    check();
  });
  return pc.localDescription.sdp;
}
export function socket(path, protocols) {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url, protocols);
}
