export function localRunner(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
    && req.headers.host === "127.0.0.1:" + req.socket.localPort
    && !("x-forwarded-for" in req.headers) && !("forwarded" in req.headers);
}
