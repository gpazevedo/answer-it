import { useState, useEffect, useCallback } from "react";

/** Decode a base64 audio string to a blob URL. */
export function b64ToBlob(audio_b64, mimeType = "audio/mpeg") {
  const binary = atob(audio_b64);
  const bytes = new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i));
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/**
 * Play TTS audio for given text via /api/speak endpoint (NDJSON stream).
 * Returns { abort(), audio } — abort stops playback, audio is the live HTMLAudioElement.
 * Chunks are played sequentially as they arrive so playback starts sooner.
 */
export function playTts(text, voice, onEnd, outputDeviceId, volume = 1) {
  const ctrl = new AbortController();
  const handle = { abort: null, audio: null };
  const blobUrls = [];
  let aborted = false;

  const cleanup = () => {
    if (handle.audio) { handle.audio.pause(); handle.audio = null; }
    blobUrls.forEach(u => URL.revokeObjectURL(u));
    blobUrls.length = 0;
  };

  handle.abort = () => { aborted = true; ctrl.abort(); cleanup(); onEnd?.(); };

  (async () => {
    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
        signal: ctrl.signal,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const queue = [];
      let streamDone = false;

      const playNext = async () => {
        if (aborted || queue.length === 0) {
          if (streamDone) { cleanup(); onEnd?.(); }
          return;
        }
        const { audio, blobUrl } = queue.shift();
        handle.audio = audio;
        if (outputDeviceId && audio.setSinkId) await audio.setSinkId(outputDeviceId);
        if (aborted) { URL.revokeObjectURL(blobUrl); return; }
        audio.addEventListener("ended", () => {
          URL.revokeObjectURL(blobUrl);
          if (queue.length > 0) playNext();
          else if (streamDone) { cleanup(); onEnd?.(); }
        }, { once: true });
        audio.play();
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const { audio_b64 } = JSON.parse(line);
          const blobUrl = b64ToBlob(audio_b64);
          blobUrls.push(blobUrl);
          const audio = new Audio(blobUrl);
          audio.volume = volume;
          const wasEmpty = queue.length === 0 && !handle.audio;
          queue.push({ audio, blobUrl });
          if (wasEmpty) playNext();
        }
      }

      streamDone = true;
      if (!handle.audio && queue.length === 0) { cleanup(); onEnd?.(); }
    } catch (err) {
      if (err.name !== "AbortError") { cleanup(); onEnd?.(); }
    }
  })();

  return handle;
}

/** Sentinel deviceId that means "capture a browser tab via getDisplayMedia". */
export const TAB_AUDIO_ID = "tab-audio";

/**
 * Acquire an audio MediaStream for the given deviceId.
 * If deviceId is TAB_AUDIO_ID, opens Chrome's tab-picker via getDisplayMedia.
 * Otherwise uses getUserMedia with an exact deviceId constraint.
 */
export async function getAudioStream(deviceId) {
  if (deviceId === TAB_AUDIO_ID) {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
    return stream;
  }
  const constraints = deviceId
    ? { audio: { deviceId: { exact: deviceId } } }
    : { audio: true };
  return navigator.mediaDevices.getUserMedia(constraints);
}

export function useAudioDevices() {
  const [audioInputs, setAudioInputs]       = useState([]);
  const [audioOutputs, setAudioOutputs]     = useState([]);
  const [selectedMic, setSelectedMic]       = useState("");
  const [selectedOutput, setSelectedOutput] = useState("");

  const refresh = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
    } catch { /* labels may be empty */ }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = [
      { deviceId: TAB_AUDIO_ID, label: "Tab audio" },
      ...devices
        .filter(d => d.kind === "audioinput")
        .map(d => ({ deviceId: d.deviceId, label: d.label || `Mic ${d.deviceId.slice(0, 6)}` })),
    ];
    const outputs = devices
      .filter(d => d.kind === "audiooutput")
      .map(d => ({ deviceId: d.deviceId, label: d.label || `Output ${d.deviceId.slice(0, 6)}` }));
    setAudioInputs(inputs);
    setAudioOutputs(outputs);
    setSelectedMic(prev => prev || inputs[1]?.deviceId || "");
    setSelectedOutput(prev => prev || outputs[0]?.deviceId || "");
  }, []);

  useEffect(() => {
    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [refresh]);

  return { audioInputs, audioOutputs, selectedMic, setSelectedMic, selectedOutput, setSelectedOutput };
}
