/**
 * daily_insurance_article.js  (Pixabay edition)
 * - Calls an LLM to generate a strict-JSON insurance article
 * - Fetches 3 illustration-style images from Pixabay
 * - Saves images under ./docs/insurance/images and appends article to ./docs/insurance/data/articles.json
 * - Sorts newest → oldest
 *
 * Requires: Node 18+ (global fetch)
 *
 * Env:
 *  - OPENAI_API_KEY=...                 (required for text)
 *  - PIXABAY_API_KEY=...                (required for images)
 *  - LLM_MODEL=gpt-4o-mini              (optional, default gpt-4o-mini)
 *  - IMG_DIR=docs/insurance/images      (optional)
 *  - IMG_BASE_URL=/insurance/images     (optional; or full CDN URL)
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";

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

// -------------------- Pixabay integration --------------------
// Docs: https://pixabay.com/api/docs/
// Notes:
// - Pixabay switched to a custom Content License; check terms.
// - To minimize 403/404, we download and self-host images.
// - We prefer illustration/vector style where possible.

function buildPixabayQuery({ title, primary_tag, tags }) {
  const parts = [primary_tag, ...(tags || [])]
    .filter(Boolean)
    .map(s => s.toLowerCase());
  // steer toward insurance concepts + illustration
  return `${parts.join(" ")} insurance illustration vector`;
}

async function pixabaySearch({ query, perPage = 20 }) {
  if (!PIXABAY_API_KEY) return [];
  console.log ("Search Pizabay")
  const url = new URL("https://pixabay.com/api/");
  url.searchParams.set("key", PIXABAY_API_KEY);
  url.searchParams.set("q", query);
  url.searchParams.set("image_type", "illustration"); // prefer illustrations
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("per_page", String(perPage));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.log  (`Pixabay API ${res.status}: ${t}`)
    throw new Error(`Pixabay API ${res.status}: ${t}`);
  }
  const data = await res.json();
  console.log  ("Pixabay data ", data);
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
  console.log ("PIXABAY_API_KEY>", PIXABAY_API_KEY);
  if (!PIXABAY_API_KEY) {
    // No key → Picsum fallback
    const slug = slugify(title || primaryTag || (tags && tags[0]) || "insurance");
    return Array.from({ length: count }, (_, i) => ({
      url: `https://picsum.photos/seed/${slug}-${dateISO}-${i + 1}/1200/800`,
      alt: `abstract insurance concept (${i + 1})`,
      source: "picsum.photos",
      license: "Placeholder",
    }));
  }
console.log ("fetchPixabayIllustrations")
  const query = buildPixabayQuery({ title, primary_tag: primaryTag, tags });
  const hits = await pixabaySearch({ query, perPage: Math.max(30, count) });
  const ranked = rankPixabayHits(hits).slice(0, count);

  const out = [];
  for (let i = 0; i < count; i++) {
    const r = ranked[i];
    const idx = i + 1;
    const baseSlug = slugify((r?.tags || title || primaryTag || "insurance") + `-${dateISO}-${idx}`);

    try {
      // Prefer large image; fall back to webformat if needed
      const src =
        r?.largeImageURL ||
        r?.webformatURL ||
        r?.previewURL;

      if (!src) throw new Error("No usable image url in hit");

      const ext = (src.split(".").pop() || "jpg").split("?")[0].toLowerCase();
      const filename = `${baseSlug}.${["jpg","jpeg","png","webp"].includes(ext) ? ext : "jpg"}`;
      const filepath = path.join(IMG_DIR, filename);

      await downloadToFile(src, filepath);
console.log ("file  downloaded")
      out.push({
        url: `${IMG_BASE_URL}/${filename}`,
        alt: (r?.tags || "insurance illustration").slice(0, 140),
        source: "Pixabay",
        license: "Pixabay Content License",
        photographer: r?.user || "",
        photographer_url: r?.pageURL || "",
      });
    } catch (err) {
      // Slot fallback
      console.log   (err);
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
  // Load existing
  const articles = readArticles();

  // 1) Generate article JSON via LLM
  const draft = await generateArticleJSON();

  // 2) Fetch 3 Pixabay illustrations aligned to topic/tags; self-host
  const images = await fetchPixabayIllustrations({
    title: draft.title,
    primaryTag: draft.primary_tag,
    tags: draft.tags,
    dateISO: draft.date,
    count: 3,
  });

  // 3) Map to site schema (first image as primary)
  const record = {
    id: draft.id,
    title: draft.title,
    excerpt: draft.excerpt,
    author: draft.author,
    date: draft.date,
    image: images[0]?.url || "",
    images,
    tag: draft.primary_tag,
    tags: draft.tags || [],
    body: draft.body_html,
  };

  // 4) De-dupe id or same-title same-day
  const exists = articles.find(a => a.id === record.id) ||
                 articles.find(a => a.title === record.title && a.date === record.date);
  if (exists) {
    // ensure unique slug suffix
    const suffix = crypto.randomBytes(2).toString("hex");
    record.id = `${record.id}-${suffix}`;
  }

  // 5) Save list newest → oldest
  const next = [record, ...articles].sort((a, b) => new Date(b.date) - new Date(a.date));
  await ensureDir(DATA_DIR);
  writeArticles(next);

  console.log("✅ Created article:", record.title, "→", record.id);
  console.log("🖼  Images:", record.images?.map(i => i.url).join(", "));
})().catch(err => {
  console.error("❌ Generation failed:", err);
  process.exitCode = 1;
});
