import { useState, useRef, useCallback, useEffect } from "react";
import {
  CLIENT_START, CLIENT_STOP, CLIENT_PAUSE_DETECTED,
  SERVER_READY, SERVER_TRANSCRIPT, SERVER_ERROR,
  FIELD_TYPE, FIELD_TEXT, FIELD_IS_FINAL, FIELD_LANGUAGE, FIELD_MODEL, FIELD_VAD,
  FIELD_MESSAGE,
  WS_TRANSCRIBE,
} from "./wsProtocol.js";

const SILENCE_THRESHOLD = 0.04;

/**
 * Manages WebSocket + MediaRecorder + silence detection for /api/transcribe.
 *
 * endpoint: pass WS_TRANSCRIBE_STREAMING for near-real-time (1s intervals).
 *   The default WS_TRANSCRIBE only transcribes on pause_detected / stop.
 */
export function useMicTranscription({
  language,
  model,
  selectedMic,
  getStream,
  silenceDurationMs = 300,
  autoStopMs = null,
  vad = true,
  endpoint = WS_TRANSCRIBE,
  micBarRef = null,
  onPartial,
  onFinal,
  onError,
}) {
  const [listenState, setListenState] = useState("idle");

  const wsRef           = useRef(null);
  const recorderRef     = useRef(null);
  const streamRef       = useRef(null);
  const stopStreamRef   = useRef(null);
  const levelRafRef     = useRef(null);
  const listenStateRef  = useRef("idle");
  const stopFnRef       = useRef(null);
  const autoStopSentRef = useRef(false);

  useEffect(() => { listenStateRef.current = listenState; }, [listenState]);

  const releaseStream = useCallback(() => {
    stopStreamRef.current?.();
    stopStreamRef.current = null;
    streamRef.current = null;
  }, []);

  const stopLevelMeter = useCallback(() => {
    if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current);
    levelRafRef.current = null;
  }, []);

  const startLevelMeter = useCallback((stream) => {
    if (!micBarRef) return;
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let silenceStart = null;
    let pauseSent = false;

    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const level = Math.min(1, avg / 80);
      // Direct DOM write to avoid React re-render
      if (micBarRef.current) {
        micBarRef.current.style.width = `${level * 100}%`;
      }

      const now = performance.now();
      if (level < SILENCE_THRESHOLD) {
        if (silenceStart === null) silenceStart = now;
        const dur = now - silenceStart;
        if (!pauseSent && dur >= silenceDurationMs) {
          pauseSent = true;
          if (wsRef.current?.readyState === WebSocket.OPEN)
            wsRef.current.send(JSON.stringify({ [FIELD_TYPE]: CLIENT_PAUSE_DETECTED }));
        }
        if (autoStopMs !== null && !autoStopSentRef.current && dur >= autoStopMs) {
          autoStopSentRef.current = true;
          stopFnRef.current?.();
        }
      } else {
        silenceStart = null;
        pauseSent = false;
      }

      levelRafRef.current = requestAnimationFrame(tick);
    };
    levelRafRef.current = requestAnimationFrame(tick);
  }, [micBarRef, silenceDurationMs, autoStopMs]);

  const attachRecorder = useCallback((stream, ws) => {
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    recorderRef.current = recorder;
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0 && ws.readyState === WebSocket.OPEN)
        ws.send(ev.data);
    };
    recorder.start(1000);
  }, []);

  const resolveStream = useCallback(async () => {
    const result = await getStream();
    if (!result) return null;
    const stream = result instanceof MediaStream ? result : result.stream;
    const cleanup = result instanceof MediaStream
      ? () => stream.getTracks().forEach(t => t.stop())
      : (result.onCleanup ?? (() => stream.getTracks().forEach(t => t.stop())));
    streamRef.current = stream;
    stopStreamRef.current = cleanup;
    return stream;
  }, [getStream]);

  const cleanup = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    recorderRef.current = null;
    releaseStream();
    stopLevelMeter();
  }, [releaseStream, stopLevelMeter]);

  const stop = useCallback(() => {
    const ws = wsRef.current;
    const recorder = recorderRef.current;

    stopLevelMeter();
    releaseStream();
    recorderRef.current = null;

    const sendStop = () => {
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ [FIELD_TYPE]: CLIENT_STOP }));
    };
    if (recorder?.state === "recording") {
      recorder.onstop = sendStop;
      recorder.stop();
    } else {
      sendStop();
    }
    setListenState("processing");
  }, [stopLevelMeter, releaseStream]);

  useEffect(() => { stopFnRef.current = stop; }, [stop]);

  const start = useCallback(async () => {
    setListenState("starting");
    autoStopSentRef.current = false;

    const stream = await resolveStream();
    if (!stream) {
      setListenState("idle");
      return;
    }
    startLevelMeter(stream);

    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${wsProto}//${location.host}${endpoint}`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        [FIELD_TYPE]: CLIENT_START,
        [FIELD_LANGUAGE]: language,
        [FIELD_MODEL]: model,
        [FIELD_VAD]: vad,
      }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg[FIELD_TYPE] === SERVER_READY) {
          setListenState("listening");
          attachRecorder(stream, ws);
        } else if (msg[FIELD_TYPE] === SERVER_TRANSCRIPT) {
          if (msg[FIELD_IS_FINAL]) {
            setListenState("finished");
            ws.close();
            onFinal?.(msg[FIELD_TEXT]);
          } else {
            onPartial?.(msg[FIELD_TEXT]);
          }
        } else if (msg[FIELD_TYPE] === SERVER_ERROR) {
          cleanup();
          setListenState("idle");
          onError?.(msg[FIELD_MESSAGE]);
        }
      } catch (err) {
        onError?.("Message parse error");
      }
    };

    ws.onerror = () => {
      cleanup();
      setListenState("idle");
      onError?.("WebSocket error");
    };
    ws.onclose = () => {
      cleanup();
    };
  }, [language, model, vad, endpoint, resolveStream, startLevelMeter, attachRecorder, cleanup, onPartial, onFinal, onError]);

  // Hot-swap stream when selectedMic changes during listening
  const resolveStreamRef = useRef(resolveStream);
  resolveStreamRef.current = resolveStream;
  const attachRecorderRef = useRef(attachRecorder);
  attachRecorderRef.current = attachRecorder;
  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;

  useEffect(() => {
    if (listenStateRef.current !== "listening" || !selectedMic) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    let mounted = true;
    (async () => {
      cleanupRef.current();
      const stream = await resolveStreamRef.current();
      if (!mounted || !stream) return;
      attachRecorderRef.current(stream, ws);
    })();
    return () => { mounted = false; };
  }, [selectedMic]);

  return { listenState, start, stop };
}
