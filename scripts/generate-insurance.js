/**
 * daily_insurance_article.js  (Pixabay + safe query)
 *
 * - Calls an LLM to generate a strict-JSON insurance article
 * - Fetches 3 illustration-style images from Pixabay (download + self-host)
 * - Writes/updates ./docs/insurance/data/articles.json (newest → oldest)
 * - Stores images under ./docs/insurance/images (or IMG_DIR)
 *
 * Requires: Node 18+ (global fetch)
 *
 * Env:
 *  - OPENAI_API_KEY=...                 (required for text)
 *  - PIXABAY_API_KEY=...                (required for images)
 *  - LLM_MODEL=gpt-4o-mini              (optional, default gpt-4o-mini)
 *  - IMG_DIR=docs/insurance/images      (optional)
 *  - IMG_BASE_URL=/insurance/images     (optional; can be a full CDN URL)
 */

// import 'dotenv/config'; // ← uncomment if you want to load a local .env

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";

// -------------------- config --------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || "";

const DATA_DIR = path.join(process.cwd(), "docs", "insurance", "data");
const ARTICLES_PATH = path.join(DATA_DIR, "articles.json");

const IMG_DIR = process.env.IMG_DIR || path.join(process.cwd(), "docs", "insurance", "images");
const IMG_BASE_URL = (process.env.IMG_BASE_URL || "/insurance/images").replace(/\/$/, "");

const todayISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// -------------------- utils --------------------

function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function readArticles() {
  if (!fs.existsSync(ARTICLES_PATH)) return [];
  try {
    const txt = fs.readFileSync(ARTICLES_PATH, "utf8").trim();
    return txt ? JSON.parse(txt) : [];
  } catch (e) {
    console.error("Failed to read/parse articles.json:", e.message);
    return [];
  }
}

function writeArticles(list) {
  fs.mkdirSync(path.dirname(ARTICLES_PATH), { recursive: true });
  fs.writeFileSync(ARTICLES_PATH, JSON.stringify(list, null, 2), "utf8");
  console.log(`Updated ${ARTICLES_PATH} (${list.length} articles)`);
}

function stripFences(s) {
  return String(s || "").replace(/^```(?:json)?\s*|\s*```$/g, "");
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function downloadToFile(url, filepath, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await ensureDir(path.dirname(filepath));
      await fsp.writeFile(filepath, buf);
      return true;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

// -------------------- prompt --------------------

function buildDailyPrompt() {
  const todayISO = new Date().toISOString().split("T")[0];
  return `
You are an experienced insurance content writer specializing in educational content for the general public.

Task:
Generate ONE new, original, high-quality article each day on a rotating insurance-related topic.

🎯 Guidelines

Audience & Tone:
- Target: general audience in the United States
- Tone: educational, approachable, neutral, and accurate
- Always include this disclaimer at the end:
  “This is general information, not individualized advice.”

Length:
- Approximately 900–1,200 words

Structure:
1. Title — clear, descriptive, and engaging
2. Excerpt — 1–2 sentences summarizing the main takeaway
3. Body — well-organized with:
   - H2 and H3 subheadings
   - Short paragraphs
   - Bulleted or numbered lists where helpful
4. FAQ — include 3 short Q&As clarifying key points

Topic Rotation & Freshness:
- Use today’s date (${todayISO}) as a seed to ensure a unique topic and angle.
- Vary content daily by switching between:
  • Beginner’s guides
  • Step-by-step checklists
  • Myth-busting explainers
  • Real-world claim scenarios
  • Risk management or underwriting basics
  • Policy comparison frameworks
  • Preventive tips and coverage optimization strategies

Content Boundaries:
Avoid:
- Premium prices or price quotes
- Specific insurer or company names
- State-by-state or legal references
- Personalized financial or legal advice
- Any data that can become outdated
Ensure information remains evergreen and factual.

Tags:
- Generate 3–6 relevant tags based on the article’s content.
- Tags should stay related to insurance but are not restricted to a fixed list.

Images:
- Do NOT return image URLs or keywords. Images are selected downstream from a provider.
- Focus on clear title/excerpt/tags so illustrations can be aligned.

Output:
Return ONLY valid JSON (no markdown fences) with the following structure:

{
  "id": "kebab-case-slug-of-title",
  "title": "Title Case",
  "excerpt": "1–2 sentence summary.",
  "author": "Staff Writer",
  "date": "${todayISO}",
  "primary_tag": "(main tag)",
  "tags": ["tag1","tag2","tag3"],
  "body_html": "<p>Full HTML article…</p>"
}
`.trim();
}

// -------------------- LLM call --------------------

async function generateArticleJSON() {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing.");
  const prompt = buildDailyPrompt();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: "You are a careful, structured content generator that always returns strict JSON." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`LLM error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  let content = data.choices?.[0]?.message?.content || "";
  content = stripFences(content);
  const obj = JSON.parse(content);

  obj.id = slugify(obj.id || obj.title || `insurance-${todayISO}`);
  obj.date = todayISO;
  obj.author ||= "Staff Writer";
  obj.primary_tag ||= (obj.tags && obj.tags[0]) || "Insurance";
  return obj;
}

// -------------------- Pixabay (safe query + fallbacks) --------------------
// API docs: https://pixabay.com/api/docs/
// We download and self-host images to avoid 403/404 from hotlinking.

// Build a safe, ≤100-character query string (Pixabay limit)
function buildPixabayQuery({ title, primary_tag, tags }) {
  const baseKeywords = [
    (primary_tag || "").toLowerCase(),
    ...(Array.isArray(tags) ? tags : []).map(t => String(t || "").toLowerCase())
  ]
    .filter(Boolean)
    .map(s => s.replace(/[^a-z0-9\s-]/g, ""))
    .map(s => s.trim())
    .filter(Boolean);

  const suffix = " insurance illustration vector";
  const uniq = [];
  for (const k of baseKeywords) {
    if (!uniq.includes(k)) uniq.push(k);
  }

  const maxQ = 100;
  let q = "";
  for (const k of uniq) {
    const candidate = (q ? q + " " : "") + k;
    if ((candidate + suffix).length <= maxQ) {
      q = candidate;
    } else {
      break;
    }
  }
  if (!q) q = (primary_tag || "insurance").toLowerCase();

  let finalQ = (q + suffix).slice(0, maxQ).trim();
  if (finalQ.length === maxQ) {
    finalQ = finalQ.replace(/\s+\S*$/, "");
  }
  return finalQ || "insurance illustration";
}

// Build a few short fallback queries (also safe-capped)
function buildPixabayFallbackQueries({ title, primary_tag, tags }) {
  const tagList = (Array.isArray(tags) ? tags : []).map(t => String(t || "").toLowerCase());
  const primary = String(primary_tag || "").toLowerCase();
  const small = (s) => (s || "").replace(/[^a-z0-9\s-]/gi, "").trim().slice(0, 45);

  const candidates = [
    small(primary),
    ...tagList.map(small),
    small(String(title || "")),
    "auto insurance",
    "homeowners insurance",
    "health insurance",
    "life insurance",
    "business insurance",
    "cyber insurance"
  ].filter(Boolean);

  const uniq = [];
  for (const c of candidates) if (!uniq.includes(c)) uniq.push(c);

  return uniq.slice(0, 6).map(k =>
    buildPixabayQuery({ title: "", primary_tag: k, tags: [] })
  );
}

async function pixabaySearch({ query, perPage = 20 }) {
  if (!PIXABAY_API_KEY) return [];
  const url = new URL("https://pixabay.com/api/");
  url.searchParams.set("key", PIXABAY_API_KEY);
  url.searchParams.set("q", query);
  url.searchParams.set("image_type", "illustration");
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("per_page", String(perPage));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.warn(`Pixabay API ${res.status} for q="${query}": ${t.slice(0, 120)}...`);
    return [];
  }
  const data = await res.json();
  return data.hits || [];
}

function rankPixabayHits(hits) {
  const kw = ["insurance", "policy", "coverage", "security", "risk", "claim", "car", "home", "health", "life", "business", "cyber"];
  const score = (t = "") => kw.reduce((acc, k) => acc + (t.toLowerCase().includes(k) ? 1 : 0), 0);
  return hits
    .map(h => ({ h, s: score(h.tags || "") }))
    .sort((a, b) => b.s - a.s)
    .map(x => x.h);
}

async function fetchPixabayIllustrations({ title, primaryTag, tags, dateISO, count = 3 }) {
  if (!PIXABAY_API_KEY) {
    const slug = slugify(title || primaryTag || (tags && tags[0]) || "insurance");
    return Array.from({ length: count }, (_, i) => ({
      url: `https://picsum.photos/seed/${slug}-${dateISO}-${i + 1}/1200/800`,
      alt: `abstract insurance concept (${i + 1})`,
      source: "picsum.photos",
      license: "Placeholder",
    }));
  }

  // 1) main safe query
  const mainQ = buildPixabayQuery({ title, primary_tag: primaryTag, tags });
  let hits = await pixabaySearch({ query: mainQ, perPage: Math.max(30, count) });

  // 2) fallback queries if empty
  if (!hits.length) {
    const fallbacks = buildPixabayFallbackQueries({ title, primary_tag: primaryTag, tags });
    for (const q of fallbacks) {
      hits = await pixabaySearch({ query: q, perPage: Math.max(30, count) });
      if (hits.length) break;
    }
  }

  if (!hits.length) {
    // last-resort: picsum placeholders so the run never fails
    const slug = slugify(title || primaryTag || (tags && tags[0]) || "insurance");
    return Array.from({ length: count }, (_, i) => ({
      url: `https://picsum.photos/seed/${slug}-${dateISO}-${i + 1}/1200/800`,
      alt: `abstract insurance concept (${i + 1})`,
      source: "picsum.photos",
      license: "Placeholder",
    }));
  }

  const ranked = rankPixabayHits(hits).slice(0, count);
  const out = [];

  for (let i = 0; i < count; i++) {
    const r = ranked[i];
    const idx = i + 1;
    const baseSlug = slugify((r?.tags || title || primaryTag || "insurance") + `-${dateISO}-${idx}`);

    try {
      const src = r?.largeImageURL || r?.webformatURL || r?.previewURL;
      if (!src) throw new Error("No usable image url in hit");

      const ext = (src.split(".").pop() || "jpg").split("?")[0].toLowerCase();
      const filename = `${baseSlug}.${["jpg","jpeg","png","webp"].includes(ext) ? ext : "jpg"}`;
      const filepath = path.join(IMG_DIR, filename);

      await downloadToFile(src, filepath);

      out.push({
        url: `${IMG_BASE_URL}/${filename}`,
        alt: (r?.tags || "insurance illustration").slice(0, 140),
        source: "Pixabay",
        license: "Pixabay Content License",
        photographer: r?.user || "",
        photographer_url: r?.pageURL || "",
      });
    } catch (err) {
      out.push({
        url: `https://picsum.photos/seed/${baseSlug}/1200/800`,
        alt: `abstract insurance concept (${idx})`,
        source: "picsum.photos",
        license: "Placeholder",
      });
    }
  }
  return out;
}

// -------------------- main --------------------

(async function main() {
  // 0) ensure dirs
  await ensureDir(DATA_DIR);
  await ensureDir(IMG_DIR);

  // 1) load existing
  const articles = readArticles();

  // 2) text: generate article JSON via LLM
  const draft = await generateArticleJSON();

  // 3) images: fetch 3 Pixabay illustrations aligned to topic/tags; self-host
  const images = await fetchPixabayIllustrations({
    title: draft.title,
    primaryTag: draft.primary_tag,
    tags: draft.tags,
    dateISO: draft.date,
    count: 3,
  });

  // 4) map to site schema (first image as primary)
  const record = {
    id: draft.id,
    title: draft.title,
    excerpt: draft.excerpt,
    author: draft.author,
    date: draft.date,
    image: images[0]?.url || "",
    tag: draft.primary_tag,
    tags: draft.tags || [],
    body: draft.body_html,
  };

  // 5) de-dupe id or same-title same-day
  const exists = articles.find(a => a.id === record.id) ||
                 articles.find(a => a.title === record.title && a.date === record.date);
  if (exists) {
    const suffix = crypto.randomBytes(2).toString("hex");
    record.id = `${record.id}-${suffix}`;
  }

  // 6) save newest → oldest
  const next = [record, ...articles].sort((a, b) => new Date(b.date) - new Date(a.date));
  writeArticles(next);

  console.log("✅ Created article:", record.title, "→", record.id);
  console.log("🖼  Images:", images[0]?.url || "");
})().catch(err => {
  console.error("❌ Generation failed:", err);
  process.exitCode = 1;
});
