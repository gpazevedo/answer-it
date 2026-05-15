// Canonical WebSocket message types for /api/transcribe protocol.
// Backend main.py must stay synchronized with these values.

export const WS_MSG = {
  // Client → Server
  START:          "start",
  PAUSE_DETECTED: "pause_detected",
  STOP:           "stop",

  // Server → Client
  READY:      "ready",
  TRANSCRIPT: "transcript",
  ERROR:      "error",
};
