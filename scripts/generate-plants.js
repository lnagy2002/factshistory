/**
 * Generate a daily plant article into articles.json (no repeats) + DeepAI image.
 *
 * Files:
 *  - docs/plants/data/articles.json         (array of article objects)
 *  - docs/plants/data/used_plants.json      (array of plant keys used)
 *  - docs/plants/images/<slug>-<date>-<id>.jpg  (generated image)
 *
 * Env:
 *  - OPENAI_API_KEY (required)
 *  - OPENAI_MODEL   (optional; default: "gpt-4o-mini")
 *  - DEEPAI_API_KEY (required for image generation)
 *
 * Run: node generate-plant-article-json.js
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const DEEPAI_API_KEY = process.env.DEEPAI_API_KEY || "";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}
if (!DEEPAI_API_KEY) {
  console.error("Missing DEEPAI_API_KEY (required to generate images with DeepAI)");
  process.exit(1);
}

const DATA_DIR = path.join(process.cwd(), "docs", "plants", "data");
const IMAGES_DIR = path.join(process.cwd(), "docs", "plants", "images");
const ARTICLES_PATH = path.join(DATA_DIR, "articles.json");
const USED_PLANTS_PATH = path.join(DATA_DIR, "used_plants.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function slugify(s) {
  return String(s)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
function readJSONSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function clamp(s, n) {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function htmlEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- OpenAI (pick random plant + article JSON) ---
async function openaiJSON(promptString) {
  // Chat Completions (stable JSON mode)
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a careful botanical writer who produces compact, factual JSON only.",
        },
        { role: "user", content: promptString },
      ],
      temperature: 0.7,
    }),
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(`OpenAI error ${res.status}: ${JSON.stringify(data)}`);
  const text = data.choices?.[0]?.message?.content || "";
  return JSON.parse(text);
}

// --- DeepAI image generation ---
async function deepAIImageForPlant(plantName, scientificName) {
  
  // Keep the prompt clear + CC-safe (no text in image)
  const textPrompt = [
    `Photo of ${plantName}${
      scientificName ? ` (${scientificName})` : ""
    },healthy food ingredients, no text, no watermark, natural lighting.`,
    `Center composition, high quality.`,
  ].join(" ");

  // Call DeepAI
  const form = new URLSearchParams();
  form.append("text", textPrompt);

  const res = await fetch("https://api.deepai.org/api/text2img", {
    method: "POST",
    headers: {
      "api-key": DEEPAI_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error(`DeepAI error ${res.status}: ${errTxt}`);
  }

  const data = await res.json();
  const url =
    data.output_url || data.output_url_0 || data.output?.url || data.id || "";
  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    throw new Error("DeepAI returned no valid image URL.");
  }

  // Download the image and store locally
  const imgResp = await fetch(url);
  if (!imgResp.ok) {
    throw new Error(`Failed to download DeepAI image: ${imgResp.status}`);
  }
  const buf = Buffer.from(await imgResp.arrayBuffer());

  const dateISO = todayISO();
  const rand = crypto.randomBytes(4).toString("hex");
  const base = slugify(`${plantName}-${dateISO}-${rand}`);
  const filename = `${base}.jpg`;
  const outPath = path.join(IMAGES_DIR, filename);
  fs.writeFileSync(outPath, buf);

  // Return site-relative path (adjust if your site expects a different prefix)
  const sitePath = `plants/images/${filename}`;
  return { sitePath, remoteUrl: url };
}

function buildHTML(article) {
  const ben = article.benefits || {};
  const prep = article.preparations || {};
  const img = article.image || {};
  const parts = [];

  parts.push(`<h2>Introduction</h2>`);
  parts.push(
    `<p><em>${htmlEsc(article.common_name)}</em>${
      article.scientific_name
        ? ` (<em>${htmlEsc(article.scientific_name)}</em>)`
        : ""
    } — ${htmlEsc(article.short_history || "")}</p>`
  );

  if (img.url) {
    parts.push(
      `<p><img src="${htmlEsc(img.url)}" alt="${htmlEsc(
        article.common_name
      )}" /></p>`
    );
    const credits = [img.credit, img.license, img.source]
      .filter(Boolean)
      .map(htmlEsc)
      .join(" · ");
    if (credits) parts.push(`<p><small>Image: ${credits}</small></p>`);
  }

  parts.push(`<h2>Benefits & Uses</h2>`);
  function ul(arr) {
    return Array.isArray(arr) && arr.length
      ? `<ul>${arr.map((x) => `<li>${htmlEsc(x)}</li>`).join("")}</ul>`
      : `<p><em>No items.</em></p>`;
  }
  parts.push(`<h3>Tea</h3>${ul(ben.tea)}`);
  parts.push(`<h3>Culinary</h3>${ul(ben.culinary)}`);
  parts.push(`<h3>Salve</h3>${ul(ben.salve)}`);
  parts.push(`<h3>Tincture</h3>${ul(ben.tincture)}`);
  parts.push(`<h3>Other</h3>${ul(ben.other)}`);

  function recipe(obj) {
    if (!obj) return `<p><em>No details.</em></p>`;
    const ing = obj.ingredients?.length
      ? `<h4>Ingredients</h4><ul>${obj.ingredients
          .map((x) => `<li>${htmlEsc(x)}</li>`)
          .join("")}</ul>`
      : "";
    const steps = obj.steps?.length
      ? `<h4>Steps</h4><ol>${obj.steps
          .map((x) => `<li>${htmlEsc(x)}</li>`)
          .join("")}</ol>`
      : "";
    const ideas = obj.ideas?.length
      ? `<h4>Ideas</h4><ul>${obj.ideas
          .map((x) => `<li>${htmlEsc(x)}</li>`)
          .join("")}</ul>`
      : "";
    return [ing, steps, ideas].filter(Boolean).join("");
  }

  parts.push(`<h2>Ways to Prepare</h2>`);
  parts.push(`<h3>Tea</h3>${recipe(prep.tea)}`);
  parts.push(`<h3>Salve</h3>${recipe(prep.salve)}`);
  parts.push(`<h3>Culinary</h3>${recipe(prep.culinary)}`);
  parts.push(`<h3>Tincture</h3>${recipe(prep.tincture)}`);

  parts.push(`<h2>Safety</h2>${ul(article.safety)}`);

  if (article.sources?.length) {
    parts.push(
      `<h2>Sources</h2><ul>${article.sources
        .map((x) => `<li>${htmlEsc(x)}</li>`)
        .join("")}</ul>`
    );
  }

  parts.push(
    `<p><small>This is educational information, not medical advice.</small></p>`
  );
  return parts.join("\n");
}

(async function main() {
  const used = readJSONSafe(USED_PLANTS_PATH, []); // array of plant_key strings
  const dateISO = todayISO();

  const prompt = [
    "Return STRICT JSON only with the schema below. Choose a RANDOM commonly known plant NOT in EXCLUSIONS.",
    'Tone: neutral, educational; avoid medical claims ("traditionally used", "studies suggest").',
    "",
    "Schema:",
    "{",
    '  "plant_key": "string",',
    '  "common_name": "string",',
    '  "scientific_name": "string",',
    '  "aliases": ["string"],',
    '  "short_history": "string",',
    '  "benefits": { "tea":["string"], "culinary":["string"], "salve":["string"], "tincture":["string"], "other":["string"] },',
    '  "preparations": {',
    '    "tea": { "ingredients":["string"], "steps":["string"] },',
    '    "salve": { "ingredients":["string"], "steps":["string"] },',
    '    "culinary": { "ideas":["string"] },',
    '    "tincture": { "ingredients":["string"], "steps":["string"] }',
    "  },",
    '  "safety": ["string"],',
    '  "image": { "url":"string", "license":"string", "credit":"string", "source":"string" },',
    '  "sources": ["string"]',
    "}",
    "",
    `EXCLUSIONS: ${JSON.stringify(used)}`,
  ].join("\n");

  const article = await openaiJSON(prompt);

  const plantKey =
    article.plant_key ||
    `${article.common_name} | ${article.scientific_name || ""}`.trim();
  if (used.includes(plantKey))
    throw new Error("Model returned excluded plant; rerun to try again.");

  // Generate image with DeepAI
  let imageRelPath = ""; // site-relative (e.g., "plants/images/foo.jpg")
  try {
    const img = await deepAIImageForPlant(
      article.common_name,
      article.scientific_name
    );
    imageRelPath = img.sitePath;
  } catch (err) {
    console.warn("DeepAI image failed; falling back to model-suggested URL:", err.message);
    // note: if article.image.url exists, we'll leave it in the HTML body (via buildHTML).
  }

  // Build target schema for articles.json
  const title = `${article.common_name}: Uses, History, and Preparations`;
  const idBase = slugify(title);
  let id = idBase;

  const articles = readJSONSafe(ARTICLES_PATH, []);
  if (!Array.isArray(articles))
    throw new Error("articles.json is not an array.");
  const existingIds = new Set(articles.map((a) => a.id));
  let suffix = 1;
  while (existingIds.has(id)) {
    id = `${idBase}-${++suffix}`;
  }

  const bodyHTML = buildHTML(article);

  const record = {
    id,
    title,
    excerpt: clamp(
      article.short_history || `Daily insight on ${article.common_name}.`,
      300
    ),
    author: "Staff Writer",
    date: dateISO,
    image:
      imageRelPath ||
      (article.image?.url || ""), // prefer local DeepAI image; else model-suggested URL
    tag: "plant",
    tags: ["plants", "herbal", "daily insight", slugify(article.common_name)],
    body: bodyHTML,
  };

  // Append newest first
  articles.unshift(record);
  writeJSON(ARTICLES_PATH, articles);

  // Update used history
  used.push(plantKey);
  writeJSON(USED_PLANTS_PATH, used);

  console.log(`Added ${article.common_name} -> articles.json (id: ${id})`);
  if (imageRelPath) console.log(`Saved image: ${imageRelPath}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
