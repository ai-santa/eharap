import { useState, useEffect, useRef } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────
const STORAGE_KEY = "pt-clients";

const DEFAULT_CLIENTS = [
  {
    id: "1",
    name: "田中 花子",
    goal: "ダイエット",
    age: 32,
    weight: 58,
    dailyCalories: 1600,
    dailyProtein: 100,
    dailyCarbs: 150,
    dailyFat: 50,
    meals: [],
  },
];

const MEAL_LABELS = { breakfast: "朝食", lunch: "昼食", dinner: "夕食", snack: "間食" };

// ─── Helpers ─────────────────────────────────────────────────────────────────
function today() {
  return new Date().toISOString().slice(0, 10);
}

function weekDates() {
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = r.result;
      const base64 = dataUrl.split(",")[1];
      // Extract actual media type from data URL
      const mediaType = dataUrl.match(/data:([^;]+);/)?.[1] || "image/jpeg";
      res({ base64, mediaType });
    };
    r.onerror = () => rej(new Error("Read failed"));
    r.readAsDataURL(file);
  });
}

// ─── Claude API ──────────────────────────────────────────────────────────────
async function analyzeImage({ base64, mediaType }, mealType, client) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            {
              type: "text",
              text: `この食事写真を栄養士として分析してください。
料理名を特定し、以下をJSON形式のみで返してください（余分なテキスト・マークダウン不要）:
{"dishes":["料理名"],"calories":数値,"protein":数値,"carbs":数値,"fat":数値,"advice":"アドバイス文"}

必ずcalories/protein/carbs/fatは整数の数値で返すこと。

顧客情報:
- 名前: ${client.name}
- 目標: ${client.goal}
- 1日の目標カロリー: ${client.dailyCalories}kcal
- 目標タンパク質: ${client.dailyProtein}g / 糖質: ${client.dailyCarbs}g / 脂質: ${client.dailyFat}g
- 食事タイミング: ${MEAL_LABELS[mealType]}`,
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.find((b) => b.type === "text")?.text || "";
  if (!text) throw new Error("APIからレスポンスがありませんでした");

  // Strip markdown fences and extract JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`JSON未検出: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]);

  // Ensure numeric values
  return {
    dishes: parsed.dishes || [],
    calories: parseInt(parsed.calories) || 0,
    protein: parseInt(parsed.protein) || 0,
    carbs: parseInt(parsed.carbs) || 0,
    fat: parseInt(parsed.fat) || 0,
    advice: parsed.advice || "",
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MacroBar({ label, value, target, color }) {
  const pct = Math.min(100, Math.round((value / target) * 100));
  const over = value > target;
  return (
    <div className="macro-bar">
      <div className="macro-bar-header">
        <span className="macro-label">{label}</span>
        <span className={`macro-value ${over ? "over" : ""}`}>
          {value} / {target}
        </span>
      </div>
      <div className="bar-track">
        <div
          className="bar-fill"
          style={{ width: `${pct}%`, background: over ? "#ef4444" : color }}
        />
      </div>
    </div>
  );
}

function MealCard({ meal, onDelete }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="meal-card">
      <div className="meal-card-top" onClick={() => setOpen(!open)}>
        <div className="meal-left">
          <span className="meal-type-badge">{MEAL_LABELS[meal.type]}</span>
          <span className="meal-dishes">{meal.dishes.join("・")}</span>
        </div>
        <div className="meal-right">
          <span className="meal-kcal">{meal.calories} kcal</span>
          <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onDelete(); }}>✕</button>
          <span className="chevron">{open ? "▲" : "▼"}</span>
        </div>
      </div>
      {open && (
        <div className="meal-detail">
          {meal.imageUrl && <img src={meal.imageUrl} alt="food" className="meal-img" />}
          <div className="meal-macros-row">
            <span>P: {meal.protein}g</span>
            <span>C: {meal.carbs}g</span>
            <span>F: {meal.fat}g</span>
          </div>
          <p className="meal-advice">{meal.advice}</p>
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [clients, setClients] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState("today"); // today | week | clients
  const [uploading, setUploading] = useState(false);
  const [mealType, setMealType] = useState("lunch");
  const [editMode, setEditMode] = useState(false);
  const [newClient, setNewClient] = useState(null);
  const [error, setError] = useState("");
  const fileRef = useRef();

  // Load from Artifact storage
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORAGE_KEY);
        const data = res ? JSON.parse(res.value) : DEFAULT_CLIENTS;
        setClients(data);
        setSelectedId(data[0]?.id || null);
      } catch {
        setClients(DEFAULT_CLIENTS);
        setSelectedId(DEFAULT_CLIENTS[0]?.id);
      }
    })();
  }, []);

  // Save to Artifact storage
  async function saveClients(updated) {
    setClients(updated);
    try {
      await window.storage.set(STORAGE_KEY, JSON.stringify(updated));
    } catch (e) {
      console.error("Storage error", e);
    }
  }

  const client = clients.find((c) => c.id === selectedId);

  function todayMeals() {
    return (client?.meals || []).filter((m) => m.date === today());
  }

  function weekSummary() {
    const dates = weekDates();
    return dates.map((date) => {
      const meals = (client?.meals || []).filter((m) => m.date === date);
      return {
        date,
        calories: meals.reduce((s, m) => s + m.calories, 0),
        protein: meals.reduce((s, m) => s + m.protein, 0),
        carbs: meals.reduce((s, m) => s + m.carbs, 0),
        fat: meals.reduce((s, m) => s + m.fat, 0),
      };
    });
  }

  const todayTotals = todayMeals().reduce(
    (acc, m) => ({
      calories: acc.calories + m.calories,
      protein: acc.protein + m.protein,
      carbs: acc.carbs + m.carbs,
      fat: acc.fat + m.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );

  async function handleUpload(e) {
    const file = e.target.files[0];
    if (!file || !client) return;
    setUploading(true);
    setError("");
    try {
      const fileData = await toBase64(file);
      const result = await analyzeImage(fileData, mealType, client);
      const imageUrl = URL.createObjectURL(file);
      const meal = {
        id: Date.now().toString(),
        date: today(),
        type: mealType,
        imageUrl,
        dishes: result.dishes || [],
        calories: result.calories || 0,
        protein: result.protein || 0,
        carbs: result.carbs || 0,
        fat: result.fat || 0,
        advice: result.advice || "",
      };
      const updated = clients.map((c) =>
        c.id === client.id ? { ...c, meals: [...c.meals, meal] } : c
      );
      await saveClients(updated);
    } catch (err) {
      setError(`解析エラー: ${err.message}`);
      console.error(err);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  function deleteMeal(mealId) {
    const updated = clients.map((c) =>
      c.id === client.id ? { ...c, meals: c.meals.filter((m) => m.id !== mealId) } : c
    );
    saveClients(updated);
  }

  function startAddClient() {
    setNewClient({
      id: Date.now().toString(),
      name: "",
      goal: "ダイエット",
      age: 30,
      weight: 60,
      dailyCalories: 1800,
      dailyProtein: 120,
      dailyCarbs: 180,
      dailyFat: 60,
      meals: [],
    });
  }

  async function saveNewClient() {
    if (!newClient.name.trim()) return;
    const updated = [...clients, newClient];
    await saveClients(updated);
    setSelectedId(newClient.id);
    setNewClient(null);
    setTab("today");
  }

  async function saveClientEdit(edited) {
    const updated = clients.map((c) => (c.id === edited.id ? edited : c));
    await saveClients(updated);
    setEditMode(false);
  }

  async function deleteClient(id) {
    const updated = clients.filter((c) => c.id !== id);
    await saveClients(updated);
    setSelectedId(updated[0]?.id || null);
  }

  const ws = weekSummary();

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=DM+Mono:wght@400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          font-family: 'Noto Sans JP', sans-serif;
          background: #0d1117;
          color: #e6edf3;
          min-height: 100vh;
        }

        .app { max-width: 480px; margin: 0 auto; padding: 0 0 80px; }

        /* Header */
        .header {
          background: linear-gradient(135deg, #161b22 0%, #1c2230 100%);
          border-bottom: 1px solid #30363d;
          padding: 16px 20px 12px;
          position: sticky; top: 0; z-index: 10;
        }
        .header-top { display: flex; justify-content: space-between; align-items: center; }
        .logo { font-size: 13px; font-weight: 700; letter-spacing: 0.12em; color: #58a6ff; text-transform: uppercase; }
        .client-select {
          background: #21262d; border: 1px solid #30363d; color: #e6edf3;
          padding: 6px 10px; border-radius: 6px; font-size: 13px;
          font-family: 'Noto Sans JP', sans-serif; cursor: pointer; flex: 1; margin: 0 10px;
        }
        .add-btn {
          background: #238636; color: #fff; border: none; border-radius: 6px;
          padding: 6px 12px; font-size: 12px; cursor: pointer; white-space: nowrap;
          font-family: 'Noto Sans JP', sans-serif;
        }
        .add-btn:hover { background: #2ea043; }

        /* Tabs */
        .tabs {
          display: flex; background: #161b22; border-bottom: 1px solid #30363d;
          position: sticky; top: 57px; z-index: 9;
        }
        .tab-btn {
          flex: 1; padding: 10px 0; font-size: 12px; font-weight: 500; letter-spacing: 0.05em;
          background: none; border: none; color: #8b949e; cursor: pointer;
          border-bottom: 2px solid transparent; transition: all 0.2s;
          font-family: 'Noto Sans JP', sans-serif;
        }
        .tab-btn.active { color: #58a6ff; border-bottom-color: #58a6ff; }

        /* Section */
        .section { padding: 16px 20px; }
        .section-title { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; color: #8b949e; text-transform: uppercase; margin-bottom: 12px; }

        /* Upload area */
        .upload-area {
          background: #161b22; border: 1.5px dashed #30363d; border-radius: 10px;
          padding: 20px; text-align: center; cursor: pointer; transition: border-color 0.2s;
        }
        .upload-area:hover { border-color: #58a6ff; }
        .upload-icon { font-size: 28px; margin-bottom: 8px; }
        .upload-text { font-size: 12px; color: #8b949e; }
        .upload-loading { display: flex; align-items: center; justify-content: center; gap: 10px; color: #58a6ff; font-size: 13px; }
        .spinner { width: 18px; height: 18px; border: 2px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        .meal-type-row { display: flex; gap: 6px; margin-bottom: 12px; }
        .type-btn {
          flex: 1; padding: 7px 4px; font-size: 11px; font-weight: 500;
          border: 1px solid #30363d; border-radius: 6px; background: #21262d;
          color: #8b949e; cursor: pointer; transition: all 0.15s;
          font-family: 'Noto Sans JP', sans-serif;
        }
        .type-btn.active { background: #1f3d5c; border-color: #58a6ff; color: #58a6ff; }

        /* Macro bars */
        .macro-bars { background: #161b22; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
        .macro-bar { margin-bottom: 10px; }
        .macro-bar:last-child { margin-bottom: 0; }
        .macro-bar-header { display: flex; justify-content: space-between; margin-bottom: 4px; }
        .macro-label { font-size: 11px; color: #8b949e; }
        .macro-value { font-size: 11px; font-family: 'DM Mono', monospace; color: #e6edf3; }
        .macro-value.over { color: #ef4444; }
        .bar-track { height: 5px; background: #21262d; border-radius: 3px; overflow: hidden; }
        .bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }

        /* Meal cards */
        .meal-card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
        .meal-card-top { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; cursor: pointer; }
        .meal-left { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
        .meal-type-badge { font-size: 10px; padding: 2px 7px; border-radius: 10px; background: #1f3d5c; color: #58a6ff; white-space: nowrap; }
        .meal-dishes { font-size: 12px; color: #e6edf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .meal-right { display: flex; align-items: center; gap: 8px; }
        .meal-kcal { font-size: 12px; font-family: 'DM Mono', monospace; color: #3fb950; }
        .icon-btn { background: none; border: none; color: #8b949e; cursor: pointer; font-size: 11px; padding: 2px 4px; }
        .icon-btn:hover { color: #ef4444; }
        .chevron { font-size: 10px; color: #8b949e; }
        .meal-detail { padding: 0 14px 14px; }
        .meal-img { width: 100%; max-height: 180px; object-fit: cover; border-radius: 6px; margin-bottom: 10px; }
        .meal-macros-row { display: flex; gap: 16px; margin-bottom: 8px; }
        .meal-macros-row span { font-size: 11px; font-family: 'DM Mono', monospace; color: #8b949e; }
        .meal-advice { font-size: 12px; color: #8b949e; line-height: 1.7; background: #0d1117; padding: 10px 12px; border-radius: 6px; border-left: 3px solid #58a6ff; }

        /* Week table */
        .week-table { background: #161b22; border-radius: 10px; overflow: hidden; border: 1px solid #30363d; }
        .week-row { display: grid; grid-template-columns: 60px 1fr 1fr 1fr 1fr; border-bottom: 1px solid #21262d; padding: 9px 14px; align-items: center; }
        .week-row.header { background: #0d1117; }
        .week-row:last-child { border-bottom: none; }
        .week-cell { font-size: 11px; text-align: right; font-family: 'DM Mono', monospace; }
        .week-cell:first-child { text-align: left; color: #8b949e; font-family: 'Noto Sans JP', sans-serif; }
        .week-cell.header { color: #8b949e; font-family: 'Noto Sans JP', sans-serif; font-size: 10px; }
        .week-cell.today-mark { color: #58a6ff; font-weight: 700; }
        .week-kcal { color: #3fb950; }
        .week-prot { color: #58a6ff; }
        .week-carb { color: #d2a679; }
        .week-fat { color: #ff7b72; }

        /* Clients */
        .client-card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
        .client-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .client-name { font-size: 15px; font-weight: 700; }
        .client-goal-badge { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: #1a3a2a; color: #3fb950; }
        .client-meta { display: flex; gap: 16px; font-size: 11px; color: #8b949e; margin-bottom: 10px; }
        .client-targets { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .target-item { background: #0d1117; border-radius: 6px; padding: 7px 10px; }
        .target-label { font-size: 10px; color: #8b949e; margin-bottom: 2px; }
        .target-value { font-size: 13px; font-family: 'DM Mono', monospace; color: #e6edf3; }
        .client-actions { display: flex; gap: 8px; margin-top: 12px; }
        .edit-btn { flex: 1; padding: 7px; font-size: 12px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; font-family: 'Noto Sans JP', sans-serif; }
        .edit-btn:hover { border-color: #58a6ff; color: #58a6ff; }
        .del-btn { padding: 7px 12px; font-size: 12px; border-radius: 6px; border: 1px solid #30363d; background: none; color: #8b949e; cursor: pointer; font-family: 'Noto Sans JP', sans-serif; }
        .del-btn:hover { border-color: #ef4444; color: #ef4444; }

        /* Form */
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .modal { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px; width: 100%; max-width: 400px; max-height: 90vh; overflow-y: auto; }
        .modal-title { font-size: 14px; font-weight: 700; margin-bottom: 16px; }
        .form-group { margin-bottom: 12px; }
        .form-label { font-size: 11px; color: #8b949e; margin-bottom: 5px; display: block; }
        .form-input {
          width: 100%; background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
          color: #e6edf3; padding: 8px 10px; font-size: 13px; font-family: 'Noto Sans JP', sans-serif;
        }
        .form-input:focus { outline: none; border-color: #58a6ff; }
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .modal-actions { display: flex; gap: 8px; margin-top: 16px; }
        .save-btn { flex: 1; padding: 9px; background: #238636; color: #fff; border: none; border-radius: 6px; font-size: 13px; cursor: pointer; font-family: 'Noto Sans JP', sans-serif; }
        .save-btn:hover { background: #2ea043; }
        .cancel-btn { padding: 9px 16px; background: none; border: 1px solid #30363d; color: #8b949e; border-radius: 6px; font-size: 13px; cursor: pointer; font-family: 'Noto Sans JP', sans-serif; }

        .error-msg { color: #ef4444; font-size: 12px; margin-top: 8px; text-align: center; }
        .empty-msg { text-align: center; color: #8b949e; font-size: 13px; padding: 30px 0; }
      `}</style>

      <div className="app">
        {/* Header */}
        <div className="header">
          <div className="header-top">
            <svg width="130" height="36" viewBox="0 0 200 50" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="gold3" x1="0" y1="0" x2="0" y2="50" gradientUnits="userSpaceOnUse">
              <stop offset="0%"   stopColor="#f5e08a"/>
              <stop offset="25%"  stopColor="#c8920c"/>
              <stop offset="55%"  stopColor="#e2b820"/>
              <stop offset="80%"  stopColor="#b07a0a"/>
              <stop offset="100%" stopColor="#8a5c06"/>
            </linearGradient>
          </defs>
          <rect width="200" height="50" rx="4" fill="#1c1208"/>
          <text
            x="100"
            y="34"
            textAnchor="middle"
            fontFamily="Didot, 'Bodoni MT', 'Playfair Display', Georgia, serif"
            fontWeight="700"
            fontSize="26"
            letterSpacing="5"
            fill="url(#gold3)"
          >EHARAP</text>
        </svg>
            <select
              className="client-select"
              value={selectedId || ""}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button className="add-btn" onClick={startAddClient}>+ 追加</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="tabs">
          {[["today", "今日の食事"], ["week", "週間サマリー"], ["clients", "顧客管理"]].map(([key, label]) => (
            <button key={key} className={`tab-btn ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>

        {/* Today */}
        {tab === "today" && client && (
          <div className="section">
            <p className="section-title">目標 vs 今日の摂取</p>
            <div className="macro-bars">
              <MacroBar label={`カロリー (kcal)`} value={todayTotals.calories} target={client.dailyCalories} color="#3fb950" />
              <MacroBar label={`タンパク質 (g)`} value={todayTotals.protein} target={client.dailyProtein} color="#58a6ff" />
              <MacroBar label={`糖質 (g)`} value={todayTotals.carbs} target={client.dailyCarbs} color="#d2a679" />
              <MacroBar label={`脂質 (g)`} value={todayTotals.fat} target={client.dailyFat} color="#ff7b72" />
            </div>

            <p className="section-title">食事を記録</p>
            <div className="meal-type-row">
              {Object.entries(MEAL_LABELS).map(([key, label]) => (
                <button key={key} className={`type-btn ${mealType === key ? "active" : ""}`} onClick={() => setMealType(key)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="upload-area" onClick={() => !uploading && fileRef.current.click()}>
              {uploading ? (
                <div className="upload-loading">
                  <div className="spinner" />
                  <span>AI解析中...</span>
                </div>
              ) : (
                <>
                  <div className="upload-icon">📷</div>
                  <div className="upload-text">写真をタップしてアップロード</div>
                </>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleUpload} />
            {error && <p className="error-msg">{error}</p>}

            <p className="section-title" style={{ marginTop: 20 }}>今日の記録</p>
            {todayMeals().length === 0 ? (
              <p className="empty-msg">まだ記録がありません</p>
            ) : (
              todayMeals().map((m) => (
                <MealCard key={m.id} meal={m} onDelete={() => deleteMeal(m.id)} />
              ))
            )}
          </div>
        )}

        {/* Week */}
        {tab === "week" && client && (
          <div className="section">
            <p className="section-title">過去7日間</p>
            <div className="week-table">
              <div className="week-row header">
                <span className="week-cell header">日付</span>
                <span className="week-cell header" style={{ textAlign: "right" }}>kcal</span>
                <span className="week-cell header" style={{ textAlign: "right" }}>P(g)</span>
                <span className="week-cell header" style={{ textAlign: "right" }}>C(g)</span>
                <span className="week-cell header" style={{ textAlign: "right" }}>F(g)</span>
              </div>
              {ws.map((row) => {
                const isToday = row.date === today();
                const d = new Date(row.date);
                const label = `${d.getMonth() + 1}/${d.getDate()}`;
                return (
                  <div key={row.date} className="week-row">
                    <span className={`week-cell ${isToday ? "today-mark" : ""}`}>{label}{isToday ? " 今" : ""}</span>
                    <span className={`week-cell week-kcal`}>{row.calories || "—"}</span>
                    <span className={`week-cell week-prot`}>{row.protein || "—"}</span>
                    <span className={`week-cell week-carb`}>{row.carbs || "—"}</span>
                    <span className={`week-cell week-fat`}>{row.fat || "—"}</span>
                  </div>
                );
              })}
              <div className="week-row" style={{ background: "#1a2332" }}>
                <span className="week-cell" style={{ color: "#58a6ff", fontWeight: 700, fontFamily: "'Noto Sans JP'" }}>目標/日</span>
                <span className="week-cell week-kcal">{client.dailyCalories}</span>
                <span className="week-cell week-prot">{client.dailyProtein}</span>
                <span className="week-cell week-carb">{client.dailyCarbs}</span>
                <span className="week-cell week-fat">{client.dailyFat}</span>
              </div>
            </div>
          </div>
        )}

        {/* Clients */}
        {tab === "clients" && (
          <div className="section">
            <p className="section-title">顧客一覧</p>
            {clients.map((c) => (
              <div key={c.id} className="client-card">
                <div className="client-card-header">
                  <span className="client-name">{c.name}</span>
                  <span className="client-goal-badge">{c.goal}</span>
                </div>
                <div className="client-meta">
                  <span>{c.age}歳</span>
                  <span>{c.weight}kg</span>
                </div>
                <div className="client-targets">
                  <div className="target-item">
                    <div className="target-label">カロリー目標</div>
                    <div className="target-value">{c.dailyCalories} <span style={{ fontSize: 10, color: "#8b949e" }}>kcal</span></div>
                  </div>
                  <div className="target-item">
                    <div className="target-label">タンパク質</div>
                    <div className="target-value">{c.dailyProtein} <span style={{ fontSize: 10, color: "#8b949e" }}>g</span></div>
                  </div>
                  <div className="target-item">
                    <div className="target-label">糖質</div>
                    <div className="target-value">{c.dailyCarbs} <span style={{ fontSize: 10, color: "#8b949e" }}>g</span></div>
                  </div>
                  <div className="target-item">
                    <div className="target-label">脂質</div>
                    <div className="target-value">{c.dailyFat} <span style={{ fontSize: 10, color: "#8b949e" }}>g</span></div>
                  </div>
                </div>
                <div className="client-actions">
                  <button className="edit-btn" onClick={() => { setSelectedId(c.id); setEditMode(true); }}>編集</button>
                  <button className="del-btn" onClick={() => deleteClient(c.id)}>削除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      {(newClient || editMode) && (() => {
        const editing = editMode ? clients.find((c) => c.id === selectedId) : null;
        const form = newClient || editing;
        const setForm = newClient
          ? setNewClient
          : (val) => {
              const updated = clients.map((c) => (c.id === val.id ? val : c));
              setClients(updated);
            };

        return (
          <div className="modal-overlay" onClick={() => { setNewClient(null); setEditMode(false); }}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <p className="modal-title">{newClient ? "顧客を追加" : "顧客を編集"}</p>
              <div className="form-group">
                <label className="form-label">名前</label>
                <input className="form-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">目標</label>
                  <select className="form-input" value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })}>
                    {["ダイエット", "筋肉増量", "体型維持", "健康改善"].map((g) => <option key={g}>{g}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">年齢</label>
                  <input className="form-input" type="number" value={form.age} onChange={(e) => setForm({ ...form, age: +e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">体重 (kg)</label>
                <input className="form-input" type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: +e.target.value })} />
              </div>
              <p style={{ fontSize: 11, color: "#8b949e", marginBottom: 10 }}>1日の目標値</p>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">カロリー (kcal)</label>
                  <input className="form-input" type="number" value={form.dailyCalories} onChange={(e) => setForm({ ...form, dailyCalories: +e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">タンパク質 (g)</label>
                  <input className="form-input" type="number" value={form.dailyProtein} onChange={(e) => setForm({ ...form, dailyProtein: +e.target.value })} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">糖質 (g)</label>
                  <input className="form-input" type="number" value={form.dailyCarbs} onChange={(e) => setForm({ ...form, dailyCarbs: +e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">脂質 (g)</label>
                  <input className="form-input" type="number" value={form.dailyFat} onChange={(e) => setForm({ ...form, dailyFat: +e.target.value })} />
                </div>
              </div>
              <div className="modal-actions">
                <button className="cancel-btn" onClick={() => { setNewClient(null); setEditMode(false); }}>キャンセル</button>
                <button className="save-btn" onClick={newClient ? saveNewClient : () => saveClientEdit(form)}>保存</button>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}
