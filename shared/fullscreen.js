// The browser handles Escape and restores the previous window size.
export function fullscreenControl(getPicture, reportError) {
  const button = document.getElementById("fullscreen");
  button.onclick = async () => {
    const picture = getPicture();
    if (!picture) return;
    try {
      await picture.requestFullscreen();
      picture.focus();
    } catch (error) {
      reportError("Could not enter full screen. " + error.message);
    }
  };
  return available => {
    button.hidden = !(available && document.fullscreenEnabled);
    if (!available && document.fullscreenElement && document.fullscreenElement === getPicture()) {
      document.exitFullscreen().catch(error => reportError(error.message));
    }
  };
}

// Both pictures use object-fit: contain. Browser fullscreen can add black bars.
export function picturePoint(picture, event) {
  const rect = picture.getBoundingClientRect();
  const width = picture.videoWidth || picture.width;
  const height = picture.videoHeight || picture.height;
  if (!width || !height || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const w = width * scale, h = height * scale;
  const x = (event.clientX - rect.left - (rect.width - w) / 2) / w;
  const y = (event.clientY - rect.top - (rect.height - h) / 2) / h;
  if (event.type === "pointerdown" && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return {x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y))};
}
