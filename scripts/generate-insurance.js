/**
 * daily_insurance_article.js — DeepAI Text2Img edition
 *
 * - Generates one insurance article (strict JSON) via OpenAI
 * - Generates 3 illustration-style images via DeepAI Text2Img
 * - Saves images under ./docs/insurance/images (self-hosted)
 * - Appends/updates ./docs/insurance/data/articles.json (newest → oldest)
 *
 * Env:
 *  - OPENAI_API_KEY=...                 (required)
 *  - DEEPAI_API_KEY=...                 (required for DeepAI images)
 *  - LLM_MODEL=gpt-4o-mini              (optional)
 *  - IMG_DIR=docs/insurance/images      (optional)
 *  - IMG_BASE_URL=/insurance/images     (optional; can be full CDN URL)
 */

// import 'dotenv/config'; // uncomment if you want .env locally

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPAI_API_KEY = process.env.DEEPAI_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

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

// -------------------- prompt (unchanged structure) --------------------

function buildDailyPrompt() {
  const d = new Date().toISOString().split("T")[0];
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
- Use today’s date (${d}) as a seed to ensure a unique topic and angle.
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
- Do NOT return image URLs or keywords. Images are generated downstream.
- Focus on clear title/excerpt/tags so illustrations can be aligned.

Output:
Return ONLY valid JSON (no markdown fences) with:

{
  "id": "kebab-case-slug-of-title",
  "title": "Title Case",
  "excerpt": "1–2 sentence summary.",
  "author": "Staff Writer",
  "date": "${d}",
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

// -------------------- DeepAI Text2Img --------------------
// Docs: endpoint https://api.deepai.org/api/text2img ; header 'api-key'; width/height 128–1536 and multiples of 32. :contentReference[oaicite:1]{index=1}

function extractH2Topics(html = "") {
  const matches = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)].map(m => m[1]);
  return matches.slice(0, 3).map(s => s.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
}

function buildDeepAIPrompt({ title, excerpt, primaryTag, tags, body_html }) {
  const keywords = [primaryTag, ...(tags || [])].filter(Boolean).slice(0, 6).join(", ");
  const ideas = extractH2Topics(body_html).join(", ");
  return `A clean flat vector illustration symbolizing ${primaryTag || "insurance coverage"}, no text, no logos, no people, modern infographic style`;
    
  // [
  //   `Flat vector / infographic-style illustration about: ${keywords || "insurance coverage"}.`,
  //   `Title cue: ${title}.`,
  //   excerpt ? `Summary: ${excerpt}` : "",
  //   ideas ? `Key ideas: ${ideas}` : "",
  //   "Requirements: minimal, professional, neutral; no text, no brand logos, no real people or buildings; clean shapes; high contrast; educational tone."
  // ].filter(Boolean).join(" ");
}

// DeepAI requires width/height multiples of 32 (recommend staying <= 1024). :contentReference[oaicite:2]{index=2}
const DAI_W = 1024; // 32 * 32
const DAI_H = 640;  // 32 * 20

async function deepaiGenerateOneImage({ prompt, filenameBase }) {
  // Returns {filename, url} (self-hosted) or throws
  const form = new URLSearchParams();
  form.set("text", prompt);
  form.set("width", String(DAI_W));
  form.set("height", String(DAI_H));
  form.set("model", "standard");       // model choice
  form.set("preference", "speed");     // prioritize faster output
  form.set("style", "classic");        // visual style

  const resp = await fetch("https://api.deepai.org/api/text2img", {
    method: "POST",
    headers: { "api-key": DEEPAI_API_KEY },
    body: form
  });
console.log ("called  deepai")
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
console.log ("  deepai call failed", `DeepAI ${resp.status}: ${t.slice(0, 160)}`)
    throw new Error(`DeepAI ${resp.status}: ${t.slice(0, 160)}`);
  }

  const data = await resp.json();
  // DeepAI typically returns `output_url` (single) or `output` (array of URLs)
  const url = data.output_url || (Array.isArray(data.output) ? data.output[0] : null);
  if (!url) throw new Error("DeepAI: no output_url in response");

  const filename = `${filenameBase}.png`;
  const filepath = path.join(IMG_DIR, filename);
  await downloadToFile(url, filepath); // self-host to avoid future 403/404

  return { filename, url: `${IMG_BASE_URL}/${filename}` };
}

async function generateDeepAIIllustrations({ title, excerpt, primaryTag, tags, body_html, dateISO, count = 1 }) {
  if (!DEEPAI_API_KEY) {
    // Hard fallback if no key: Picsum
    const topic = slugify(primaryTag || title || "insurance").split("-").slice(0, 3).join("-");
    return Array.from({ length: count }, (_, i) => ({
      url: `https://picsum.photos/seed/${topic}-${dateISO}-${i + 1}/1200/800`,
      alt: `abstract insurance concept (${i + 1})`,
      source: "picsum.photos",
      license: "Placeholder"
    }));
  }

  await ensureDir(IMG_DIR);
  const baseTopic = slugify(primaryTag || title || "insurance").split("-").slice(0, 3).join("-");
  const promptBase = buildDeepAIPrompt({ title, excerpt, primaryTag, tags, body_html });

  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = i + 1;
    const filenameBase = `${baseTopic}-${dateISO.replace(/-/g, "")}-${idx}`;
    // slight per-image focus shift using tags
    const focus = (tags && tags[i]) ? ` Focus on: ${tags[i]}.` : "";
    const prompt = `${promptBase}${focus}`;

    try {
      const { url } = await deepaiGenerateOneImage({ prompt, filenameBase });
      out.push({
        url,
        alt: `illustration of ${(primaryTag || "insurance").toLowerCase()} concept (${idx})`,
        source: "DeepAI Text2Img",
        license: "DeepAI Terms"
      });
    } catch (err) {
      console.log ("failed  to generate image", err);
      // slot fallback
      out.push({
        url: `https://picsum.photos/seed/${filenameBase}/1200/800`,
        alt: `abstract insurance concept (${idx})`,
        source: "picsum.photos",
        license: "Placeholder"
      });
    }
  }
  return out;
}

// -------------------- main --------------------

(async function main() {
  await ensureDir(DATA_DIR);
  await ensureDir(IMG_DIR);

  const articles = readArticles();

  // 1) Generate article JSON via LLM
  const draft = await generateArticleJSON();

  // 2) Generate 1 DeepAI illustrations (self-hosted)
  const images = await generateDeepAIIllustrations({
    title: draft.title,
    excerpt: draft.excerpt,
    primaryTag: draft.primary_tag,
    tags: draft.tags,
    body_html: draft.body_html,
    dateISO: draft.date,
    count: 1
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
    body: draft.body_html
  };

  // 4) De-dupe id or same-title same-day
  const exists = articles.find(a => a.id === record.id) ||
                 articles.find(a => a.title === record.title && a.date === record.date);
  if (exists) {
    const shortId = crypto.randomBytes(2).toString("hex");
    record.id = `${record.id}-${shortId}`;
  }

  // 5) Save newest → oldest
  const next = [record, ...articles].sort((a, b) => new Date(b.date) - new Date(a.date));
  writeArticles(next);

  console.log("✅ Created article:", record.title, "→", record.id);
  console.log("🖼  Images:", record.images?.map(i => i.url).join(", "));
})().catch(err => {
  console.error("❌ Generation failed:", err);
  process.exitCode = 1;
});
