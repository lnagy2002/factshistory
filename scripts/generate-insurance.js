/**
 * daily_insurance_article.js
 * - Calls an LLM with a strict JSON prompt to generate an insurance article
 * - Generates 3 flat vector/cartoon illustrations via OpenAI Images API
 * - Saves images under ./docs/insurance/images and appends article to ./articles.json
 * - Sorts newest → oldest
 *
 * Requires: Node 18+ (for global fetch)
 * Env:
 *  - OPENAI_API_KEY=...        (required)
 *  - LLM_MODEL=gpt-4o-mini     (optional override)
 *  - IMG_DIR=docs/insurance/images                 (optional override)
 *  - IMG_BASE_URL=/insurance/images                (optional override; use full CDN URL if hosting)
 *
 * Files:
 *  - ./docs/insurance/data/articles.json   (array of articles used by your site)
 *  - ./docs/insurance/images/*.png         (generated illustrations)
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const outDir  = path.join(process.cwd(), "docs", "insurance", "data");
const ARTICLES_PATH = path.resolve(outDir, "articles.json");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

// Image output (defaults for GitHub Pages-style /docs)
const IMG_DIR = process.env.IMG_DIR || path.join(process.cwd(), "docs", "insurance", "images");
const IMG_BASE_URL = (process.env.IMG_BASE_URL || "/insurance/images").replace(/\/$/, "");

// --- Helpers ---------------------------------------------------------------

const todayISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

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

// Remove possible code fences from LLM responses
function stripFences(s) {
  return String(s || "").replace(/^```(?:json)?\s*|\s*```$/g, "");
}

// Ensure directory exists
async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

// --- Build the LLM prompt (images handled in code, not by the model) ------

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
- Examples:
  "Auto Insurance", "Home Coverage", "Health Policy", "Risk Management",
  "Claims Process", "Policy Renewal", "Small Business Coverage", "Insurance Literacy",
  "Cyber Protection", "Travel Safety", "Pet Coverage", etc.

Images:
- Do NOT return image URLs or keywords. Images are generated downstream.
- Focus on producing a specific, clear title, excerpt, and tags so illustrations can be thematically aligned.

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

// --- Call the LLM ----------------------------------------------------------

async function generateArticleJSON() {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing. Set it in your environment.");
  }
  const prompt = buildDailyPrompt();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: "You are a careful, structured content generator that always returns strict JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      response_format: { type: "json_object" }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`LLM error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  let content = data.choices?.[0]?.message?.content || "";
  content = stripFences(content);
  const obj = JSON.parse(content);

  // Normalize/guard fields
  obj.id = slugify(obj.id || obj.title || `insurance-${todayISO}`);
  obj.date = todayISO;
  obj.author ||= "Staff Writer";
  obj.primary_tag ||= (obj.tags && obj.tags[0]) || "Insurance";
  return obj;
}

// --- OpenAI Image Generation (illustrations only) --------------------------

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function buildImagePrompt({ title, primaryTag, tags }) {
  const topic = [primaryTag, ...(tags || [])].filter(Boolean).slice(0, 6).join(", ");
  return `
Flat vector/cartoon illustration about: ${topic || "insurance coverage"}.
Professional, neutral tone. Clean shapes, minimal palette, high contrast.
No text, no brand logos, no real people, no identifiable buildings.
Simple background, infographic-like aesthetic.
Title cue: ${title}.
`.trim();
}

async function generateIllustrations({ title, primaryTag, tags, dateISO, count = 3, width = 1200, height = 800 }) {
  await ensureDir(IMG_DIR);

  const slug = slugify(title || primaryTag || (tags && tags[0]) || "insurance");
  const promptBase = buildImagePrompt({ title, primaryTag, tags });

  const out = [];
  for (let i = 0; i < count; i++) {
    // Small per-image variation, with seed baked into filename
    const prompt = `${promptBase}\nVariant ${i + 1}. Focus: ${(tags && tags[i]) || primaryTag || "insurance concept"}.`;
    const filename = `${slug}-${dateISO}-${i + 1}.png`;
    const filepath = path.join(IMG_DIR, filename);

    try {
      const resp = await openai.images.generate({
        model: "gpt-image-1",
        prompt,
        size: `${width}x${height}`,
        n: 1,
        response_format: "b64_json"
      });

      const b64 = resp.data?.[0]?.b64_json;
      if (!b64) throw new Error("No image data returned");
      const buf = Buffer.from(b64, "base64");
      await fsp.writeFile(filepath, buf);

      out.push({
        url: `${IMG_BASE_URL}/${filename}`,
        alt: `illustration of ${(primaryTag || "insurance").toLowerCase()} concept (${i + 1})`,
        license: "Generated (OpenAI)",
        source: "gpt-image-1"
      });
    } catch (err) {
      // Fallback: Picsum (always 200 OK)
      out.push({
        url: `https://picsum.photos/seed/${slug}-${dateISO}-${i + 1}/${width}/${height}`,
        alt: `abstract insurance concept (${i + 1})`,
        license: "Placeholder (Picsum)",
        source: "picsum.photos"
      });
    }
  }
  return out;
}

// --- Main ------------------------------------------------------------------

(async function main() {
  const articles = readArticles();

  // 1) Generate article JSON via LLM
  const draft = await generateArticleJSON();

  // 2) Generate 3 illustration images, inject into draft
  const images = await generateIllustrations({
    title: draft.title,
    primaryTag: draft.primary_tag,
    tags: draft.tags,
    dateISO: draft.date,
    count: 3,
    width: 1200,
    height: 800
  });

  // 3) Map to your site’s schema (keep first as main image; store all in images)
  const record = {
    id: draft.id,
    title: draft.title,
    excerpt: draft.excerpt,
    author: draft.author,
    date: draft.date,
    image: images[0]?.url,       // primary image for listing
    images,                      // keep full set if your site uses a gallery
    tag: draft.primary_tag,      // primary tag for grid
    tags: draft.tags || [],      // all tags
    body: draft.body_html        // article HTML
  };

  // 4) De-dupe by id or same-title same-day
  const exists = articles.find(a => a.id === record.id) ||
                 articles.find(a => a.title === record.title && a.date === record.date);
  if (exists) {
    const suffix = crypto.randomBytes(2).toString("hex");
    record.id = `${record.id}-${suffix}`;
  }

  // 5) Append + sort newest → oldest
  const next = [record, ...articles].sort((a, b) => new Date(b.date) - new Date(a.date));
  writeArticles(next);

  console.log("Created article:", record.title, "→", record.id);
  console.log("Images:", record.images?.map(i => i.url).join(", "));
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
