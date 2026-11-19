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
