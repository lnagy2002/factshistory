// scripts/generate-wordle-json.js
// Generates kid-friendly daily Wordle words via OpenAI and writes docs/data/wordle-YYYYMMDD.json

import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// UTC helpers so “daily” aligns with GitHub cron (UTC)
const pad = n => String(n).padStart(2, "0");
function mmddyyyy(d = new Date()) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}${dd}${yyyy}`;
}

function validateShape(obj) {
  const levels = ["easy", "medium", "hard"];
  if (!obj || typeof obj !== "object") return false;
  return levels.every((lvl) => {
    const o = obj[lvl];
    return (
      o &&
      typeof o.q === "string" &&
      typeof o.a === "string" &&
      typeof o.hint === "string" &&
      o.q.trim() &&
      o.a.trim() &&
      o.hint.trim()
    );
  });
}

function trimTopLevel(value) {
  if (Array.isArray(value)) {
    return value.map(v => (typeof v === "string" ? v.trim() : v));
  }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      if (typeof value[k] === "string") value[k] = value[k].trim();
    }
    return value;
  }
  return typeof value === "string" ? value.trim() : value;
}

// Simple validators
const isAlpha = s => /^[A-Z]+$/.test(s);
const hasLength = (s, n) => s.length === n;

async function main() {
  const today = new Date();
  const stamp = mmddyyyy(today);

  const system = `
You are a riddle generator for a daily kids’ brain-training app. 
Each day you must produce exactly 3 riddles, one for each difficulty level:

- Easy (Grades 2–3): simple, playful, concrete
- Medium (Grades 4–5): reasoning, patterns, light wordplay
- Hard (Grades 6+): logic puzzles, lateral thinking, abstract ideas, but still kid-appropriate

Rules:
- Do NOT repeat any riddle question you have ever generated before. 
- Keep wording short, clear, and age-appropriate.
- Today’s date is: YYYY-MM-DD (include it internally to avoid repeats).
- Output must be strictly valid JSON, exactly matching this schema:

{
  "easy":   {"q": "WORDS", "a": "WORDS", "hint": "WORDS"},
  "medium": {"q": "WORDS", "a": "WORDS", "hint": "WORDS"},
  "hard":   {"q": "WORDS", "a": "WORDS", "hint": "WORDS"}
}

Return ONLY the JSON. No extra text.`;

  const user = `Generate riddles for date : ${stamp}.
Return fresh, school-safe riddles.`;

  // Chat Completions style (compatible with official SDK)
  const resp = await client.chat.completions.create({
    model: "gpt-5-nano",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    reasoning_effort: "minimal", // preferred control knob
  });

  const text = resp.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Empty response from model.");

  // Basic JSON guard: strip code fences if present
  const jsonString = text.replace(/^```json\s*|\s*```$/g, "");
  
  let data;
  try {
    const parsed = JSON.parse(text);
    data = trimTopLevel(parsed);   // trims only direct string values
    console.log(data);
  } catch {
    throw new Error("Model did not return valid JSON.");
  }

  if (!validateShape(data)) {
    console.warn("[daily-riddles] Invalid shape, will retry.");
    throw new Error("Invalid json");
  }
  
  // Write docs/data/daily-YYYYMMDD.json
  const outDir  = path.join(process.cwd(), "docs", "data");
  const outFile = path.join(outDir, `riddle-${stamp}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log("Wrote:", outFile, data);
}

main().catch(err => {
  console.error("Generation failed:", err);
  process.exit(1);
});
