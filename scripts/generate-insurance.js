/**
 * daily_insurance_article.js — DeepAI Text2Img + Novelty Guard
 *
 * What’s new:
 *  - Rotates daily “angle archetypes” to push variety
 *  - Supplies recent titles/tags as EXPLICIT "do-not-repeat" constraints
 *  - Rejects near-duplicates via simple Jaccard/shingle checks & re-prompts
 *  - Hardens ID uniqueness; fixes last console log
 *
 * Env (unchanged):
 *  - OPENAI_API_KEY, DEEPAI_API_KEY, LLM_MODEL (default gpt-4o-mini)
 *  - IMG_DIR (default docs/insurance/images)
 *  - IMG_BASE_URL (default /factshistory/insurance/images)
 */

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
const IMG_BASE_URL = (process.env.IMG_BASE_URL || "/factshistory/insurance/images").replace(/\/$/, "");

const todayISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// ---------- utils ----------

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

// ---------- novelty helpers (no external deps) ----------

const NOVELTY_WINDOW_DAYS = 90;         // look back window
const MAX_REPROMPTS = 3;                // how many “try a different angle” attempts
const TITLE_SIM_THRESHOLD = 0.4;        // Jaccard title similarity threshold
const BODY_SIM_THRESHOLD = 0.28;        // rough shingle similarity threshold
const SHINGLE_N = 5;                    // body shingle length (words)

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function jaccard(aArr, bArr) {
  const A = new Set(aArr);
  const B = new Set(bArr);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

function shingles(words, n = SHINGLE_N) {
  const out = [];
  for (let i = 0; i <= words.length - n; i++) {
    out.push(words.slice(i, i + n).join(" "));
  }
  return out;
}

function bodySimilarity(htmlA, htmlB) {
  const textA = String(htmlA || "").replace(/<[^>]+>/g, " ");
  const textB = String(htmlB || "").replace(/<[^>]+>/g, " ");
  const wa = tokenize(textA);
  const wb = tokenize(textB);
  if (wa.length < SHINGLE_N || wb.length < SHINGLE_N) return 0;
  const Sa = new Set(shingles(wa));
  const Sb = new Set(shingles(wb));
  const inter = [...Sa].filter(x => Sb.has(x)).length;
  const uni = new Set([...Sa, ...Sb]).size || 1;
  return inter / uni;
}

function recentWindow(articles, days = NOVELTY_WINDOW_DAYS) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return articles.filter(a => {
    const d = new Date(a.date || a.createdAt || 0);
    return d >= cutoff;
  });
}

function isTooSimilar(draft, recents) {
  const tTokens = tokenize(draft.title || "");
  for (const r of recents) {
    const rTitleT = tokenize(r.title || "");
    const tSim = jaccard(tTokens, rTitleT);
    if (tSim >= TITLE_SIM_THRESHOLD) return { clash: "title", against: r, score: tSim };

    const bSim = bodySimilarity(draft.body_html || draft.body || "", r.body || "");
    if (bSim >= BODY_SIM_THRESHOLD) return { clash: "body", against: r, score: bSim };
  }
  return null;
}

// ---------- prompt builders with “avoid” lists & daily archetypes ----------

const ANGLE_ARCHETYPES = [
  "Beginner’s guide with plain-language definitions",
  "Step-by-step checklist with common pitfalls",
  "Myth-busting explainer with evidence-based clarifications",
  "Real-world claim scenario: timeline, mistakes to avoid, lessons learned",
  "Risk management basics: prevention, deductibles, and limits trade-offs",
  "Policy comparison framework: how to evaluate coverage vs. exclusions",
  "Coverage optimization strategies: bundling, endorsements, and gaps"
];

function dailyAngle() {
  const d = new Date(todayISO);
  const idx = (d.getUTCFullYear() * 372 + d.getUTCMonth() * 31 + d.getUTCDate()) % ANGLE_ARCHETYPES.length;
  return ANGLE_ARCHETYPES[idx];
}

function buildDailyPrompt({ avoidTitles = [], avoidTags = [], forceAngle = null }) {
  const d = todayISO;
  const archetype = forceAngle || dailyAngle();

  const avoidTitleLines = avoidTitles.slice(0, 15).map(t => `- ${t}`).join("\n");
  const avoidTagLines = avoidTags.slice(0, 15).map(t => `- ${t}`).join("\n");

  return `
You are an experienced insurance content writer specializing in educational content for the general U.S. audience.

Goal: Generate ONE new, original, high-quality article today with a DISTINCT topic & angle (${d} seed).

Angle archetype for today: **${archetype}**. Apply it to a topic that is *not* close to recent items.

Do NOT repeat or closely resemble these recent titles (semantic or phrasing):
${avoidTitleLines || "- (none)"}

Avoid focusing on these tags/themes, unless you take a clearly different sub-niche or audience:
${avoidTagLines || "- (none)"}

Guidelines:
- Tone: educational, approachable, neutral, accurate
- Length: ~900–1,200 words
- Structure:
  1) Title (engaging, specific, not clickbait)
  2) Excerpt (1–2 sentences)
  3) Body (H2/H3 subheads, short paragraphs, bullets where helpful)
  4) FAQ (3 concise Q&As)
- Always end body with this disclaimer:
  “This is general information, not individualized advice.”

Topic Rotation & Freshness:
- Use today’s date (${d}) as a seed and pick an angle distinct from the avoided items above.
- Rotate among: beginner guides, checklists, myth-busting, real claim timelines, risk basics, comparisons, optimization tactics.

Content Boundaries:
- No prices, quotes, or company names
- No state-by-state or legal specifics
- No personalized advice
- Keep evergreen

Tags:
- 3–6 relevant tags; specific to the chosen topic/angle (no generic repetition).

Output:
Return ONLY valid JSON (no markdown) with keys:
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

// ---------- LLM wrappers with novelty enforcement ----------

async function callOpenAIJSON(prompt) {
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
      temperature: 0.85, // slightly higher to increase variation
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
  return JSON.parse(content);
}

function normalizeDraft(obj) {
  const id = slugify(obj.id || obj.title || `insurance-${todayISO}`);
  return {
    ...obj,
    id,
    date: todayISO,
    author: obj.author || "Staff Writer",
    primary_tag: obj.primary_tag || (obj.tags && obj.tags[0]) || "Insurance",
  };
}

async function generateArticleJSONWithNovelty(recents) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing.");

  const avoidTitles = recents.map(r => r.title).filter(Boolean);
  // Build a conservative recent tag cloud
  const avoidTagsSet = new Set();
  for (const r of recents) {
    if (r.tag) avoidTagsSet.add(String(r.tag).toLowerCase());
    (r.tags || []).forEach(t => avoidTagsSet.add(String(t).toLowerCase()));
  }
  const avoidTags = [...avoidTagsSet];

  let attempt = 0;
  let lastReason = null;

  while (attempt <= MAX_REPROMPTS) {
    const prompt = buildDailyPrompt({
      avoidTitles,
      avoidTags,
      forceAngle: attempt === 0 ? null : ANGLE_ARCHETYPES[(attempt + 1) % ANGLE_ARCHETYPES.length],
    });

    const raw = await callOpenAIJSON(prompt);
    const draft = normalizeDraft(raw);

    // Quick local similarity screening
    const clash = isTooSimilar(
      { title: draft.title, body_html: draft.body_html },
      recents.map(r => ({ title: r.title, body: r.body }))
    );

    if (!clash) return draft;

    lastReason = `similar ${clash.clash} vs “${clash.against.title}” (score ${clash.score.toFixed(2)})`;
    // Tweak avoidance by adding the just-produced title/tag as well
    avoidTitles.unshift(draft.title);
    if (draft.primary_tag) avoidTags.unshift(String(draft.primary_tag).toLowerCase());
    attempt++;
  }

  throw new Error(`Novelty guard: could not produce a sufficiently distinct article after ${MAX_REPROMPTS + 1} attempts (${lastReason}).`);
}

// ---------- DeepAI helpers ----------

function extractH2Topics(html = "") {
  const matches = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)].map(m => m[1]);
  return matches.slice(0, 3).map(s => s.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
}

function buildDeepAIPrompt({ title, excerpt, primaryTag, tags, body_html }) {
  const ideas = extractH2Topics(body_html).join(", ");
  // Keep it short & explicit; DeepAI tends to respect concise prompts
  return [
    `Photographic illustration (no text) symbolizing: ${primaryTag || "insurance coverage"}.`,
    ideas ? `Key notions: ${ideas}.` : "",
    `Provide an image response only, without any text or description. HIGH-RESOLUTION PHOTO. PHOTOGRAPHIC RESPONSE ONLY`,
    `Neutral, professional, modern; no logos, no faces; depth-of-field; high detail.`
  ].filter(Boolean).join(" ");
}

const DAI_W = 1024;
const DAI_H = 640;

async function deepaiGenerateOneImage({ prompt, filenameBase }) {
  const form = new URLSearchParams();
  form.set("text", prompt);
  form.set("width", String(DAI_W));
  form.set("height", String(DAI_H));
  form.set("model", "standard");
  form.set("preference", "speed");
  form.set("style", "classic");

  const resp = await fetch("https://api.deepai.org/api/text2img", {
    method: "POST",
    headers: { "api-key": DEEPAI_API_KEY },
    body: form
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`DeepAI ${resp.status}: ${t.slice(0, 160)}`);
  }

  const data = await resp.json();
  const url = data.output_url || (Array.isArray(data.output) ? data.output[0] : null);
  if (!url) throw new Error("DeepAI: no output_url in response");

  const filename = `${filenameBase}.png`;
  const filepath = path.join(IMG_DIR, filename);
  await downloadToFile(url, filepath);

  return { filename, url: `${IMG_BASE_URL}/${filename}` };
}

async function generateDeepAIIllustrations({ title, excerpt, primaryTag, tags, body_html, dateISO, count = 1 }) {
  if (!DEEPAI_API_KEY) {
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
    const timestamp = Math.floor(Date.now() / 1000);
    const filenameBase = `${baseTopic}-${dateISO.replace(/-/g, "")}-${idx}-${timestamp}`;
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
      console.warn("DeepAI generation failed, using fallback:", err.message);
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

// ---------- main ----------

(async function main() {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing.");
  await ensureDir(DATA_DIR);
  await ensureDir(IMG_DIR);

  const articles = readArticles();

  // Build a novelty window from recent items
  const recent = recentWindow(articles).map(a => ({
    title: a.title || "",
    body: a.body || "",
    tag: (a.tag || "").toString(),
    tags: Array.isArray(a.tags) ? a.tags : [],
    date: a.date
  }));

  // 1) Generate article JSON via LLM with novelty guard (re-prompts if needed)
  const draft = await generateArticleJSONWithNovelty(recent);

  // 2) Generate 1 DeepAI illustration (self-hosted)
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
    tag: draft.primary_tag,
    tags: draft.tags || [],
    body: draft.body_html
  };

  // 4) De-dupe robustly: same-day title or same id or high similarity
  const sameDayTitle = articles.find(a => a.title === record.title && a.date === record.date);
  const sameId = articles.find(a => a.id === record.id);
  let finalId = record.id;

  if (sameDayTitle || sameId) {
    finalId = `${record.id}-${crypto.randomBytes(2).toString("hex")}`;
  }

  // also guard against accidental near-duplicate body vs *very recent* last article
  const last = articles[0];
  if (last) {
    const nearDup = isTooSimilar(
      { title: record.title, body_html: record.body },
      [{ title: last.title, body: last.body }]
    );
    if (nearDup) {
      finalId = `${record.id}-${crypto.randomBytes(2).toString("hex")}`;
    }
  }

  const finalRecord = { ...record, id: finalId };

  // 5) Save newest → oldest
  const next = [finalRecord, ...articles].sort((a, b) => new Date(b.date) - new Date(a.date));
  writeArticles(next);

  console.log("✅ Created article:", finalRecord.title, "→", finalRecord.id);
  console.log("🖼  Image:", finalRecord.image);
})().catch(err => {
  console.error("❌ Generation failed:", err);
  process.exitCode = 1;
});
