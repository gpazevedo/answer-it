import { useState, useRef, useCallback, useEffect } from "react";
import { C } from "./lib/theme.js";
import { playTts, useAudioDevices } from "./lib/audio.js";
import { DeviceSelect, AudioLevelMeter, WaveformGadget, VolumeSlider } from "./lib/ui.jsx";
import { useMicTranscription } from "./lib/transcription.js";
import { WS_TRANSCRIBE_STREAMING } from "./lib/wsProtocol.js";

const TTS_VOICE = "en-US-EricNeural";

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json();
}

const MIC_CONSTRAINTS = (deviceId) => ({
  audio: {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    noiseSuppression: true,
    echoCancellation: true,
  },
});

// ── States ─────────────────────────────────────────────────────────
// idle → speaking → listening → answered

export default function PracticePanel() {
  const [state, setState] = useState("idle");
  const [question, setQuestion] = useState(null);
  const [finalText, setFinalText] = useState("");
  const [partialText, setPartialText] = useState("");
  const finalTextRef = useRef("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]);

  // Load history on mount
  useEffect(() => { api("/api/history").then(h => setHistory(Array.isArray(h) ? h : [])); }, []);

  const timerRef = useRef(null);
  const startTimeRef = useRef(0);
  const micBarRef = useRef(null);
  const ttsRef = useRef(null);
  const historyRef = useRef(null);
  const questionRef = useRef(null);
  useEffect(() => { questionRef.current = question; }, [question]);

  // ── Split position ───────────────────────────────────────────────
  const [splitPos, setSplitPos] = useState(55);
  const [dragging, setDragging] = useState(false);

  const onSplitMouseDown = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    document.body.style.userSelect = "none";
    const onMove = (e) => {
      e.preventDefault();
      const x = e.clientX;
      const pct = Math.max(25, Math.min(75, (x / window.innerWidth) * 100));
      setSplitPos(pct);
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      setDragging(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // ── Mic & output test state ──────────────────────────────────────
  const [micTesting, setMicTesting] = useState(false);
  const [outTesting, setOutTesting] = useState(false);
  const [micTestBlob, setMicTestBlob] = useState(null);
  const micTestLevelRef = useRef(0);
  const micTestCleanupRef = useRef(null);

  // ── Gain & volume ────────────────────────────────────────────────
  const [micGain, setMicGain] = useState(100);
  const [outVolume, setOutVolume] = useState(100);

  // ── Font sizes ───────────────────────────────────────────────────
  const [questionFontSize, setQuestionFontSize] = useState(22);
  const [answerFontSize, setAnswerFontSize] = useState(15);

  const {
    audioInputs: mics, selectedMic, setSelectedMic,
    audioOutputs: outputs, selectedOutput, setSelectedOutput,
  } = useAudioDevices();

  const micOptions = mics.map(d => ({ value: d.deviceId, label: d.label }));
  const outOptions = outputs.map(d => ({ value: d.deviceId, label: d.label }));

  // ── Mic test ─────────────────────────────────────────────────────

  const toggleMicTest = useCallback(async () => {
    if (micTesting) {
      micTestCleanupRef.current?.();
      setMicTesting(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS(selectedMic));
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = micGain / 100;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(gain);
      gain.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      let raf = null;
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        micTestLevelRef.current = Math.min(1, avg / 80);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = () => setMicTestBlob(new Blob(chunks, { type: "audio/webm" }));
      recorder.start(100);

      micTestCleanupRef.current = () => {
        if (raf) cancelAnimationFrame(raf);
        recorder.stop();
        stream.getTracks().forEach(t => t.stop());
        ctx.close();
        micTestLevelRef.current = 0;
      };
      setMicTestBlob(null);
      setMicTesting(true);
    } catch (e) {
      setError("Mic test failed: " + e.message);
    }
  }, [micTesting, selectedMic, micGain]);

  useEffect(() => () => micTestCleanupRef.current?.(), []);

  // ── Output test ──────────────────────────────────────────────────

  const toggleOutTest = useCallback(() => {
    if (outTesting) {
      if (ttsRef.current) { ttsRef.current.abort(); ttsRef.current = null; }
      setOutTesting(false);
      return;
    }
    setOutTesting(true);
    ttsRef.current = playTts("Testing audio output.", TTS_VOICE, () => {
      setOutTesting(false);
      ttsRef.current = null;
    }, selectedOutput, outVolume / 100);
  }, [outTesting, selectedOutput, outVolume]);

  // ── Mic transcription ────────────────────────────────────────────

  const gainNodeRef = useRef(null);

  useEffect(() => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = micGain / 100;
  }, [micGain]);

  const getMicStream = useCallback(async () => {
    const raw = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS(selectedMic));
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(raw);
    const gain = ctx.createGain();
    gain.gain.value = micGain / 100;
    gainNodeRef.current = gain;
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(dest);
    return {
      stream: dest.stream,
      onCleanup: () => {
        raw.getTracks().forEach(t => t.stop());
        ctx.close();
        gainNodeRef.current = null;
      },
    };
  }, [selectedMic, micGain]);

  const { listenState, start: startMic, stop: stopMic } = useMicTranscription({
    language: "en",
    model: "small",
    selectedMic,
    getStream: getMicStream,
    endpoint: WS_TRANSCRIBE_STREAMING,
    micBarRef,
    autoStopMs: 4000,
    vad: true,
    onPartial: (text) => setPartialText(text),
    onFinal: (text) => {
      setPartialText("");
      const time = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const full = finalTextRef.current ? finalTextRef.current + " " + text : text;
      finalTextRef.current = full;
      setFinalText(full);
      const entry = {
        id: Date.now(),
        question: questionRef.current?.text || "?",
        answer: full || "(no answer)",
        time,
      };
      setHistory(h => [entry, ...h]);
      // Fire-and-forget save to backend
      api("/api/history", {
        method: "POST",
        body: JSON.stringify({ question: entry.question, answer: entry.answer, time: entry.time }),
      });
      setState(prev => {
        if (prev !== "listening") return prev;
        if (timerRef.current) clearInterval(timerRef.current);
        return "answered";
      });
    },
    onError: (msg) => setError(msg),
  });


  // Timer
  useEffect(() => {
    if (state === "listening") {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 100);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [state]);

  // Auto-scroll history
  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history]);

  const startPractice = async () => {
    if (ttsRef.current) { ttsRef.current.abort(); ttsRef.current = null; }
    setError("");
    setFinalText("");
    finalTextRef.current = "";
    setPartialText("");
    setElapsed(0);
    const q = await api("/api/questions/random");
    if (q.error) { setError(q.error); return; }
    setQuestion(q);
    setState("speaking");
    ttsRef.current = playTts(q.text, TTS_VOICE, () => {
      if (ttsRef.current) {
        ttsRef.current = null;
        setState("listening");
        startMic();
      }
    }, selectedOutput, outVolume / 100);
  };

  const handleAnswer = () => {
    if (ttsRef.current) { ttsRef.current.abort(); ttsRef.current = null; }
    setState("listening");
    setElapsed(0);
    startMic();
  };

  const handleStop = () => {
    stopMic();
    setState("answered");
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const handleNext = () => startPractice();

  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const FONT_SIZES = [12, 14, 16, 18, 20, 22, 24, 28, 32];

  const FontSizeSelect = ({ label, value, onChange }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ color: C.textFaint, fontSize: 11, letterSpacing: 2 }}>{label}</span>
      <select
        value={value}
        onChange={e => onChange(parseInt(e.target.value))}
        style={{
          background: "#111008", color: C.text,
          border: `1px solid ${C.divider}`,
          borderRadius: 5, padding: "4px 8px",
          fontSize: 11, cursor: "pointer",
          fontFamily: "'Courier Prime', monospace",
          width: 58,
        }}
      >
        {FONT_SIZES.map(s => (
          <option key={s} value={s}>{s}px</option>
        ))}
      </select>
    </div>
  );

  const testBtn = (label, active, onClick) => (
    <button onClick={onClick} style={{
      background: active ? "#22cc66" : "transparent",
      color: active ? "#000" : "#22cc66",
      border: `1px solid ${active ? "#22cc66" : "rgba(34,204,102,0.3)"}`,
      borderRadius: 4, padding: "3px 8px", fontSize: 10,
      fontFamily: "inherit", cursor: "pointer",
      letterSpacing: 1,
    }}>
      {active ? "STOP" : label}
    </button>
  );

  // ── Render helpers ─────────────────────────────────────────────────

  const renderCurrent = () => (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "flex-start",
      gap: 20, paddingTop: 30, overflowY: "auto",
    }}>
      {error && (
        <div style={{ color: "#c44", fontSize: 13, textAlign: "center" }}>{error}</div>
      )}

      {state === "idle" && (
        <button onClick={startPractice} style={{
          background: C.amber, color: C.bg, border: "none",
          padding: "16px 48px", fontSize: 18, fontFamily: "inherit",
          cursor: "pointer", fontWeight: "bold", letterSpacing: 2,
        }}>
          START PRACTICE
        </button>
      )}

      {question && state !== "idle" && (
        <div style={{
          fontSize: questionFontSize, fontFamily: "'EB Garamond', serif", color: C.amber,
          textAlign: "center", lineHeight: 1.4, fontStyle: "italic",
        }}>
          "{question.text}"
        </div>
      )}

      {state === "speaking" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 13, color: C.section }}>Listen to the question...</div>
          <button onClick={handleAnswer} style={{
            background: "none", border: `1px solid ${C.amber}`, color: C.amber,
            padding: "10px 28px", fontSize: 14, fontFamily: "inherit", cursor: "pointer",
          }}>
            ANSWER NOW
          </button>
        </div>
      )}

      {state === "listening" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: "100%" }}>
          <div style={{
            fontSize: 32, fontFamily: "'Courier Prime', monospace", color: "#c44",
            fontVariantNumeric: "tabular-nums",
          }}>
            {formatTime(elapsed)}
          </div>
          <AudioLevelMeter barRef={micBarRef} />
          <div style={{ fontSize: 13, color: listenState === "listening" ? "#4c4" : C.section }}>
            {listenState === "listening" ? "Recording..." : listenState}
          </div>
          {(partialText || finalText) && (
            <div style={{
              width: "100%", background: C.bgControls, border: `1px solid ${C.divider}`,
              padding: 16, fontSize: answerFontSize, fontFamily: "'EB Garamond', serif",
              color: C.text, lineHeight: 1.6, whiteSpace: "pre-wrap",
            }}>
              {finalText && <span>{finalText} </span>}
              {partialText && <span style={{ color: C.amber, fontStyle: "italic" }}>{partialText}</span>}
            </div>
          )}
          <button onClick={handleStop} style={{
            background: "#c44", color: C.bg, border: "none",
            padding: "12px 36px", fontSize: 14, fontFamily: "inherit",
            cursor: "pointer", fontWeight: "bold",
          }}>
            STOP
          </button>
        </div>
      )}

      {state === "answered" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, width: "100%" }}>
          <div style={{
            fontSize: 14, color: C.section, fontVariantNumeric: "tabular-nums",
          }}>
            Time: {formatTime(elapsed)}
          </div>

          {finalText ? (
            <div style={{
              width: "100%", background: C.bgControls, border: `1px solid ${C.divider}`,
              padding: 20, fontSize: answerFontSize, fontFamily: "'EB Garamond', serif",
              color: C.text, lineHeight: 1.6, minHeight: 60, whiteSpace: "pre-wrap",
            }}>
              {finalText}
            </div>
          ) : (
            <div style={{ color: C.section, fontSize: 14 }}>No answer recorded.</div>
          )}

          <button onClick={handleNext} style={{
            background: C.amber, color: C.bg, border: "none",
            padding: "12px 36px", fontSize: 14, fontFamily: "inherit",
            cursor: "pointer", fontWeight: "bold", letterSpacing: 1,
          }}>
            NEXT QUESTION
          </button>
        </div>
      )}
    </div>
  );

  const renderHistory = () => (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
    }}>
      <div style={{
        padding: "12px 16px", fontSize: 12, color: C.section,
        borderBottom: `1px solid ${C.divider}`,
        letterSpacing: 2,
      }}>
        HISTORY
      </div>
      <div ref={historyRef} style={{
        flex: 1, overflowY: "auto", padding: 8,
      }}>
        {history.length === 0 && (
          <div style={{
            textAlign: "center", color: C.textFaint, fontSize: 12,
            padding: 20,
          }}>
            Answers will appear here.
          </div>
        )}
        {history.map(item => (
          <div key={item.id} style={{
            padding: "10px 12px", borderBottom: `1px solid ${C.divider}`,
            fontSize: 12,
          }}>
            <div style={{
              color: C.amber, fontFamily: "'EB Garamond', serif",
              fontSize: questionFontSize, fontStyle: "italic", marginBottom: 4,
            }}>
              "{item.question}"
            </div>
            <div style={{ color: C.text, fontFamily: "'EB Garamond', serif", fontSize: answerFontSize, lineHeight: 1.4, marginBottom: 4 }}>
              {item.answer}
            </div>
            <div style={{ color: C.section, fontSize: 11 }}>
              {formatTime(item.time)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", padding: "20px 12px" }}>
      {/* Settings bar */}
      <div style={{
        width: "100%", display: "flex", justifyContent: "flex-end", alignItems: "flex-start", gap: 24, marginBottom: 16,
        fontSize: 12, color: C.section,
      }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {micTesting && <WaveformGadget levelRef={micTestLevelRef} />}
            {micTestBlob && !micTesting && (
              <button onClick={() => {
                const a = new Audio(URL.createObjectURL(micTestBlob));
                a.play();
              }} style={{
                background: "transparent", color: "#22cc66", border: "1px solid rgba(34,204,102,0.3)",
                borderRadius: 4, padding: "3px 8px", fontSize: 10, fontFamily: "inherit", cursor: "pointer",
              }}>
                REPLAY
              </button>
            )}
            {testBtn("TEST", micTesting, toggleMicTest)}
            <DeviceSelect label="MIC" options={micOptions} value={selectedMic} onChange={setSelectedMic} />
          </div>
          <VolumeSlider label="GAIN" value={micGain} onChange={setMicGain} />
        </div>

        {/* Font size column */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <FontSizeSelect label="Q" value={questionFontSize} onChange={setQuestionFontSize} />
          <FontSizeSelect label="A" value={answerFontSize} onChange={setAnswerFontSize} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {testBtn("TEST", outTesting, toggleOutTest)}
            <DeviceSelect label="OUT" options={outOptions} value={selectedOutput} onChange={setSelectedOutput} />
          </div>
          <VolumeSlider label="VOL" value={outVolume} onChange={setOutVolume} />
        </div>
      </div>

      {/* Split panel */}
      <div style={{
        flex: 1, display: "flex", overflow: "hidden",
      }}>
        {/* Left — current Q&A */}
        <div style={{
          width: `${splitPos}%`, overflowY: "auto",
          display: "flex", flexDirection: "column",
          pointerEvents: dragging ? "none" : "auto",
        }}>
          {renderCurrent()}
        </div>

        {/* Divider */}
        <div
          onMouseDown={onSplitMouseDown}
          onMouseUp={() => setDragging(false)}
          style={{
            width: 6, cursor: "col-resize",
            background: dragging ? C.amberDim : "transparent",
            flexShrink: 0,
            transition: dragging ? "none" : "background 0.15s",
          }}
        />

        {/* Right — history */}
        <div style={{
          width: `${100 - splitPos}%`, overflow: "hidden",
          pointerEvents: dragging ? "none" : "auto",
        }}>
          {renderHistory()}
        </div>
      </div>
    </div>
  );
}
