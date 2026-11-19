// Installed before Boxedwine only in the shared game iframe.
(() => {
  const NativeAudio = window.AudioContext;
  window.AudioContext = class extends NativeAudio {
    get destination() {
      if (!this.tap) {
        this.tap = this.createMediaStreamDestination();
        parent.gameAudio(window, this.tap.stream, this);
      }
      return this.tap;
    }
  };
  let counter = 0, previous;
  window.setSharedPad = s => {
    const packet = new Uint8Array(16);
    const view = new DataView(packet.buffer);
    view.setUint16(4,s.buttons,true);
    s.triggers.forEach((v,i)=>packet[6+i] = Math.round(v*255));
    s.axes.forEach((v,i)=>{
      const axis = i%2 ? -v : v;
      view.setInt16(8+2*i,Math.round(axis*(axis<0 ? 32768 : 32767)),true);
    });
    const signature = packet.join(",");
    if (signature === previous) return;
    view.setUint32(0,++counter,true);
    FS.writeFile(Config.d_drive+"/fifa-pad.bin",packet);
    previous = signature;
  };
  window.initSharedPad = () => {
    window.setSharedPad({buttons:0,triggers:[0,0],axes:[0,0,0,0]});
    parent.gameBoot(window);
  };
})();
