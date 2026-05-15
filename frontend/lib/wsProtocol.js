// Message types (client → server)
export const CLIENT_START = "start";
export const CLIENT_STOP = "stop";
export const CLIENT_PAUSE_DETECTED = "pause_detected";

// Message types (server → client)
export const SERVER_READY = "ready";
export const SERVER_TRANSCRIPT = "transcript";
export const SERVER_LEVEL = "level";
export const SERVER_ERROR = "error";

// Field names
export const FIELD_TYPE = "type";
export const FIELD_TEXT = "text";
export const FIELD_IS_FINAL = "is_final";
export const FIELD_LANGUAGE = "language";
export const FIELD_MODEL = "model";
export const FIELD_VAD = "vad";
export const FIELD_SOURCE = "source";
export const FIELD_SESSION_ID = "session_id";
export const FIELD_RMS = "rms";
export const FIELD_MESSAGE = "message";
export const FIELD_PREVIEW = "preview";

// WebSocket endpoint paths
export const WS_TRANSCRIBE = "/api/transcribe";
export const WS_TRANSCRIBE_STREAMING = "/api/transcribe-streaming";
