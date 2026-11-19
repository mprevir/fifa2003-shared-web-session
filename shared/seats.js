export function seatControls(send, releaseInput) {
  const buttons = [...document.querySelectorAll("[data-seat]")];
  let state;
  for (const button of buttons) {
    const seat = Number(button.dataset.seat);
    button.onclick = () => {
      const leaving = state.seat === seat;
      if (leaving) releaseInput();
      send({ type: leaving ? "leave" : "claim", seat, session: state.session });
    };
  }
  return next => {
    state = next;
    const canChoose = ["starting", "streaming"].includes(state?.phase);
    for (const button of buttons) {
      const seat = Number(button.dataset.seat);
      const mine = state?.seat === seat;
      const occupancy = state?.seats[seat];
      const label = "Player " + seat;
      button.textContent = mine ? "Leave" : label;
      if (!mine && ["occupied", "reconnecting"].includes(occupancy)) {
        button.textContent += " (" + occupancy + ")";
      }
      button.setAttribute("aria-label", mine ? "Leave " + label : button.textContent);
      button.disabled = !canChoose || (!mine && (!!state.seat || occupancy !== "open"));
    }
  };
}
