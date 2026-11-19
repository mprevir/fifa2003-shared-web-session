export const codes = ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","KeyS","KeyD","KeyA","KeyW",
  "KeyQ","KeyE","ShiftLeft","ControlLeft","Enter","Escape","Space","Backspace","Tab","KeyZ","KeyC"];
export const masks = [4096,8192,16384,32768,256,512,0,0,32,16,64,128,1,2,4,8];
// FIFA's generic DirectInput layout uses button 4 to trigger a run and button 5 for a through ball.
// Xidi exposes those buttons as Y and LB respectively.
const guestButtons = {
  ArrowUp:1, ArrowDown:2, ArrowLeft:4, ArrowRight:8,
  KeyS:0x2000, KeyD:0x4000, KeyA:0x1000, KeyW:0x0100,
  KeyQ:0x8000, KeyE:512, ShiftLeft:512, ControlLeft:0x8000, Enter:16, Escape:32, Space:4096,
};
const guestMasks = codes.map(code => guestButtons[code] ?? 0);
export const neutral = () => ({keys:0, buttons:0, axes:[0,0,0,0], triggers:[0,0], x:0.5, y:0.5, down:false});
export function valid(s) {
  const int = (v,max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
  const range = (v,min,max) => Number.isFinite(v) && v >= min && v <= max;
  return s && int(s.seq,Number.MAX_SAFE_INTEGER) && int(s.keys,(1 << codes.length)-1)
    && int(s.buttons,65535) && Array.isArray(s.axes) && s.axes.length === 4 && s.axes.every(v=>range(v,-1,1))
    && Array.isArray(s.triggers) && s.triggers.length === 2 && s.triggers.every(v=>range(v,0,1))
    && range(s.x,0,1) && range(s.y,0,1) && typeof s.down === "boolean";
}
export function readPad(s, pad, seat) {
  if (pad) {
    masks.forEach((m,i) => { if (pad.buttons[i]?.pressed) s.buttons |= m; });
    s.axes = s.axes.map((_,i) => pad.axes[i] || 0);
    s.triggers = [6,7].map(i=>pad.buttons[i]?.value || 0);
  }
  if (seat === 2) {
    guestMasks.forEach((m,i)=> { if (s.keys & (1<<i)) s.buttons |= m; });
    s.keys = 0;
    if (s.buttons & 12) s.axes[0] = Number(!!(s.buttons & 8)) - Number(!!(s.buttons & 4));
    if (s.buttons & 3) s.axes[1] = Number(!!(s.buttons & 2)) - Number(!!(s.buttons & 1));
  } else {
    const map = [1,2,4,8,4096,8192,16384,32768,256,512,512,256,16,32,4096];
    map.forEach((m,i)=> { if (i !== 10 && i !== 11 && i !== 14 && (s.buttons & m)) s.keys |= 1<<i; });
    [s.axes[1]<-0.4,s.axes[1]>0.4,s.axes[0]<-0.4,s.axes[0]>0.4].forEach((pressed,i)=>{
      if (pressed) s.keys |= 1<<i;
    });
  }
}
