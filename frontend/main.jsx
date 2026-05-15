import { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { C, btnSmall } from "./lib/theme.js";
import { ScanLines, Vignette } from "./lib/ui.jsx";
import PracticePanel from "./practice.jsx";

// ── Helpers ───────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json();
}

// ── Questions Panel ───────────────────────────────────────────────

function QuestionsPanel() {
  const [questions, setQuestions] = useState([]);
  const [newText, setNewText] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");

  const load = useCallback(async () => {
    const data = await api("/api/questions");
    setQuestions(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!newText.trim()) return;
    await api("/api/questions", {
      method: "POST",
      body: JSON.stringify({ text: newText.trim(), eligible: true }),
    });
    setNewText("");
    load();
  };

  const toggleEligible = async (q) => {
    await api(`/api/questions/${q.id}`, {
      method: "PUT",
      body: JSON.stringify({ text: q.text, eligible: !q.eligible }),
    });
    load();
  };

  const startEdit = (q) => {
    setEditingId(q.id);
    setEditText(q.text);
  };

  const saveEdit = async () => {
    if (!editText.trim()) return;
    await api(`/api/questions/${editingId}`, {
      method: "PUT",
      body: JSON.stringify({ text: editText.trim(), eligible: true }),
    });
    setEditingId(null);
    setEditText("");
    load();
  };

  const remove = async (id) => {
    await api(`/api/questions/${id}`, { method: "DELETE" });
    load();
  };

  const eligible = questions.filter(q => q.eligible).length;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{
        padding: "16px 20px", borderBottom: `1px solid ${C.divider}`,
        display: "flex", gap: 8, alignItems: "center",
      }}>
        <input
          value={newText}
          onChange={e => setNewText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
          placeholder="Add a new question..."
          style={{
            flex: 1, background: C.bgControls, border: `1px solid ${C.amber}`,
            color: C.text, padding: "8px 12px", fontFamily: "inherit", fontSize: 14,
            outline: "none", borderRadius: 2,
          }}
        />
        <button onClick={add} style={{
          ...btnSmall, background: C.amber, color: C.bg,
          padding: "8px 16px", fontWeight: "bold",
        }}>
          ADD
        </button>
      </div>

      <div style={{
        padding: "8px 20px", fontSize: 12, color: C.section,
        borderBottom: `1px solid ${C.divider}`,
      }}>
        {questions.length} questions ({eligible} eligible)
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {questions.length === 0 && (
          <div style={{ textAlign: "center", color: C.section, padding: 40, fontSize: 14 }}>
            No questions yet. Add one above.
          </div>
        )}
        {questions.map(q => (
          <div key={q.id} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
            borderBottom: `1px solid ${C.divider}`,
            opacity: q.eligible ? 1 : 0.4,
          }}>
            <button
              onClick={() => toggleEligible(q)}
              title={q.eligible ? "Eligible — click to exclude" : "Excluded — click to include"}
              style={{
                width: 12, height: 12, borderRadius: "50%", border: `2px solid ${C.amber}`,
                background: q.eligible ? C.amber : "transparent",
                cursor: "pointer", flexShrink: 0, padding: 0,
              }}
            />

            {editingId === q.id ? (
              <input
                value={editText}
                onChange={e => setEditText(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditingId(null); }}
                autoFocus
                style={{
                  flex: 1, background: C.bgControls, border: `1px solid ${C.amber}`,
                  color: C.text, padding: "4px 8px", fontFamily: "inherit", fontSize: 14,
                  outline: "none", borderRadius: 2,
                }}
              />
            ) : (
              <span style={{ flex: 1, fontSize: 14, color: C.text }}>{q.text}</span>
            )}

            {editingId === q.id ? (
              <button onClick={saveEdit} style={{ ...btnSmall, color: C.amber, fontSize: 12 }}>SAVE</button>
            ) : (
              <button onClick={() => startEdit(q)} style={{ ...btnSmall, color: C.text, fontSize: 12 }}>EDIT</button>
            )}
            <button onClick={() => remove(q.id)} style={{ ...btnSmall, color: "#c44", fontSize: 12 }}>DEL</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────

const TABS = ["QUESTIONS", "PRACTICE"];

export default function App() {
  const [tab, setTab] = useState(TABS[0]);

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      background: C.bg, color: C.text,
      fontFamily: "'Courier Prime', monospace",
    }}>
      <ScanLines />
      <Vignette />

      {/* Tab bar */}
      <div style={{
        display: "flex", borderBottom: `1px solid ${C.divider}`,
        padding: "0 20px", gap: 0, position: "relative", zIndex: 1,
      }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: "none", border: "none",
            borderBottom: tab === t ? `2px solid ${C.amber}` : "2px solid transparent",
            color: tab === t ? C.amber : C.section,
            padding: "12px 20px", fontSize: 13, fontFamily: "inherit",
            cursor: "pointer", letterSpacing: 1,
          }}>
            {t}
          </button>
        ))}
      </div>

      {/* Panels — keep both mounted */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <div style={{
          position: "absolute", inset: 0,
          display: tab === "QUESTIONS" ? "flex" : "none",
        }}>
          <QuestionsPanel />
        </div>
        <div style={{
          position: "absolute", inset: 0,
          display: tab === "PRACTICE" ? "flex" : "none",
        }}>
          <PracticePanel />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
