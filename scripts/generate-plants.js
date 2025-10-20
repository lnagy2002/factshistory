/**
 * Generate a daily plant article (Markdown; no repeats) using OpenAI only.
 *
 * Outputs:
 *   - posts/YYYY-MM-DD-<plant-slug>.md
 *   - data/used_plants.json (history of used plants)
 *
 * Env:
 *   - OPENAI_API_KEY (required)
 *   - OPENAI_MODEL   (optional, default "gpt-5.1-mini")
 *
 * Run:
 *   node generate-plant-article.js
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";


const OUT_DIR_POSTS = path.join(process.cwd(), "docs", "plants", "data");
const ARTICLES_PATH = path.join(OUT_DIR_POSTS, "articles.json");
const USED_PLANTS_PATH = path.join(OUT_DIR_POSTS, 'used_plants.json');

fs.mkdirSync(OUT_DIR_POSTS, { recursive: true });
fs.mkdirSync(path.dirname(USED_PLANTS_PATH), { recursive: true });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || '"gpt-4o-mini';
// const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY. Please set it in your environment.');
  process.exit(1);
}


function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function slugify(str) {
  return String(str)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}
function readJSONSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function escapeYAML(s) { return String(s).replace(/"/g, '\\"'); }
function formatList(arr) {
  if (!Array.isArray(arr) || !arr.length) return "- (none specified)\n";
  return arr.map(x => `- ${x}`).join('\n') + '\n';
}
function formatSublist(obj) {
  if (!obj) return "- (none specified)\n";
  const lines = [];
  if (obj.ingredients?.length) {
    lines.push("**Ingredients:**");
    lines.push(...obj.ingredients.map(x => `- ${x}`));
  }
  if (obj.steps?.length) {
    lines.push("\n**Steps:**");
    lines.push(...obj.steps.map((x, i) => `${i + 1}. ${x}`));
  }
  return lines.join('\n') + '\n';
}

async function chooseAndWriteArticle() {
  const used = readJSONSafe(USED_PLANTS_PATH, []);      // array of strings (canonical keys)
  const dateISO = todayISO();

  // Ask OpenAI to: 1) pick a plant not in exclusions, 2) return full article JSON
  const payload = {
    model: OPENAI_MODEL,
    text: { format: { type: "json_object" } },
    input: [
      "You are a careful botanical writer.",
      "Return STRICT JSON ONLY matching the schema below. No preface, no prose, no markdown.",
      "",
      "Schema:",
      "{",
      '  "plant_key": "string",               // unique canonical key; use "<Common Name> | <Scientific Name>"',
      '  "common_name": "string",',
      '  "scientific_name": "string",',
      '  "aliases": ["string"],',
      '  "short_history": "string",',
      '  "benefits": {',
      '    "tea": ["string"],',
      '    "culinary": ["string"],',
      '    "salve": ["string"],',
      '    "tincture": ["string"],',
      '    "other": ["string"]',
      '  },',
      '  "preparations": {',
      '    "tea": { "ingredients": ["string"], "steps": ["string"] },',
      '    "salve": { "ingredients": ["string"], "steps": ["string"] },',
      '    "culinary": { "ideas": ["string"] },',
      '    "tincture": { "ingredients": ["string"], "steps": ["string"] }',
      '  },',
      '  "safety": ["string"],',
      '  "image": {',
      '    "url": "string",                  // Prefer Wikimedia Commons or other public-domain/CC images',
      '    "license": "string",              // e.g., CC BY-SA 4.0, Public Domain',
      '    "credit": "string",               // author/uploader credit',
      '    "source": "string"                // page URL for attribution',
      '  },',
      '  "sources": ["string"]               // reputable references (peer-reviewed, NIH/NCCIH, academic press, Kew, etc.)',
      "}",
      "",
      "Requirements:",
      "- Choose a RANDOM plant commonly known to the public (culinary, medicinal, or widely recognized garden herb).",
      "- DO NOT return any plant present in the EXCLUSIONS list.",
      "- Tone: neutral, educational; avoid medical claims (use cautious language such as “traditionally used,” “studies suggest”).",
      "- Benefits should map to likely uses (tea/culinary/salve/tincture/other).",
      "- Preparations should be practical and concise.",
      "- Safety must note allergies and medication interactions when relevant.",
      "- Image must be public-domain or Creative Commons when possible; provide license and credit.",
      "",
      `EXCLUSIONS: ${JSON.stringify(used)}`,
    ].join('\n')
  };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI error: ${res.status} ${JSON.stringify(data)}`);
  }

  // Extract text JSON depending on model
  const text =
    data.output_text ||
    data.output?.[0]?.content?.[0]?.text ||
    data.choices?.[0]?.message?.content ||
    '';

  let article;
  try {
    article = JSON.parse(text);
  } catch (e) {
    throw new Error('Failed to parse model JSON. Raw: ' + text?.slice(0, 300));
  }

  // Validate not in exclusions; if violated, try again (up to 3 attempts)
  let attempts = 1;
  while (article?.plant_key && used.includes(article.plant_key) && attempts < 3) {
    attempts++;
    console.warn(`Model returned excluded plant (${article.plant_key}); retrying (${attempts})...`);
    return await chooseAndWriteArticle();
  }

  if (!article.common_name) throw new Error('Missing common_name from model response.');
  const title = `${article.common_name}: Uses, History, and Preparations`;
  const slug = slugify(`${dateISO}-${article.common_name}`);
  const postPath = path.join(OUT_DIR_POSTS, `${slug}.md`);

  const md = renderMarkdown({
    dateISO,
    title,
    article
  });

  fs.writeFileSync(postPath, md, 'utf8');
  console.log(`Wrote: ${postPath}`);

  // Update history
  const key = article.plant_key || `${article.common_name} | ${article.scientific_name || ''}`.trim();
  if (key && !used.includes(key)) {
    used.push(key);
    writeJSON(USED_PLANTS_PATH, used);
  }

  console.log('Done.');
}

function renderMarkdown({ dateISO, title, article }) {
  const img = article.image || {};
  return [
`---`,
`title: "${escapeYAML(title)}"`,
`date: "${dateISO}"`,
`slug: "${slugify(title)}"`,
`image_url: "${img.url || ""}"`,
`image_license: "${img.license || ""}"`,
`image_credit: "${img.credit || ""}"`,
`image_source: "${img.source || ""}"`,
`---`,
``,
`# ${title}`,
article.scientific_name ? `*Scientific name:* ${article.scientific_name}` : ``,
article.aliases?.length ? `\n*Also called:* ${article.aliases.join(', ')}` : ``,
``,
img.url ? `![${article.common_name}](${img.url})` : `> (Add an image: consider Wikimedia Commons for CC/PD images)`,
img.credit || img.license || img.source
  ? `\n*Image credit:* ${[img.credit, img.license, img.source].filter(Boolean).join(' · ')}` : ``,
``,
`## Short history`,
`${article.short_history || ""}`,
``,
`## Benefits & uses`,
`**Tea:**`,
formatList(article.benefits?.tea),
`**Culinary:**`,
formatList(article.benefits?.culinary),
`**Salve:**`,
formatList(article.benefits?.salve),
`**Tincture:**`,
formatList(article.benefits?.tincture),
`**Other:**`,
formatList(article.benefits?.other),
``,
`## Preparations`,
`### Tea`,
formatSublist(article.preparations?.tea),
`### Salve`,
formatSublist(article.preparations?.salve),
`### Culinary ideas`,
formatList(article.preparations?.culinary?.ideas),
`### Tincture`,
formatSublist(article.preparations?.tincture),
``,
`## Safety`,
formatList(article.safety),
``,
`## Sources`,
formatList(article.sources)
  ].filter(Boolean).join('\n');
}

// Run
chooseAndWriteArticle().catch(err => {
  console.error(err);
  process.exit(1);
});
