function loopback(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}

export function localRunner(req) {
  return loopback(req) && req.headers.host === `127.0.0.1:${req.socket.localPort}` &&
    !("x-forwarded-for" in req.headers) && !("forwarded" in req.headers);
}

export function lanPlayer(req, playerHost) {
  return loopback(req) && playerHost && req.headers.host === playerHost &&
    req.headers["x-forwarded-proto"] === "https" && !!req.headers["x-forwarded-for"];
}
