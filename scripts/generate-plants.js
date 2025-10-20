#!/usr/bin/env node
/**
 * Generate a daily plant article into articles.json (no repeats).
 *
 * Files:
 *  - articles.json                  (array of article objects)
 *  - data/used_plants.json          (array of plant keys used)
 *
 * Env:
 *  - OPENAI_API_KEY (required)
 *  - OPENAI_MODEL   (optional; default: "gpt-4o-mini")
 *
 * Run: node generate-plant-article-json.js
 */

const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const DATA_DIR = path.join(process.cwd(), "docs", "plants", "data");
const ARTICLES_PATH = path.join(DATA_DIR, 'articles.json');
const USED_PLANTS_PATH = path.join(DATA_DIR, 'used_plants.json');
fs.mkdirSync(path.dirname(USED_PLANTS_PATH), { recursive: true });

function todayISO() { return new Date().toISOString().slice(0,10); }
function slugify(s) {
  return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
}
function readJSONSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fallback; }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function clamp(s, n) { s = String(s||'').trim(); return s.length>n ? s.slice(0,n-1)+'…' : s; }
function htmlEsc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

async function openaiJSON(promptString){
  // Use Chat Completions with enforced JSON (most stable for now)
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:'POST',
    headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a careful botanical writer who produces compact, factual JSON only." },
        { role: "user", content: promptString }
      ],
      temperature: 0.7
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${JSON.stringify(data)}`);
  const text = data.choices?.[0]?.message?.content || '';
  return JSON.parse(text);
}

function buildHTML(article){
  const ben = article.benefits || {};
  const prep = article.preparations || {};
  const img = article.image || {};
  const parts = [];

  parts.push(`<h2>Introduction</h2>`);
  parts.push(`<p><em>${htmlEsc(article.common_name)}</em>${article.scientific_name?` (<em>${htmlEsc(article.scientific_name)}</em>)`:''} — ${htmlEsc(article.short_history||'')}</p>`);

  if (img.url) {
    parts.push(`<p><img src="${htmlEsc(img.url)}" alt="${htmlEsc(article.common_name)}" /></p>`);
    const credits = [img.credit, img.license, img.source].filter(Boolean).map(htmlEsc).join(' · ');
    if (credits) parts.push(`<p><small>Image: ${credits}</small></p>`);
  }

  parts.push(`<h2>Benefits & Uses</h2>`);
  function ul(arr){ return Array.isArray(arr)&&arr.length ? `<ul>${arr.map(x=>`<li>${htmlEsc(x)}</li>`).join('')}</ul>` : `<p><em>No items.</em></p>`; }
  parts.push(`<h3>Tea</h3>${ul(ben.tea)}`);
  parts.push(`<h3>Culinary</h3>${ul(ben.culinary)}`);
  parts.push(`<h3>Salve</h3>${ul(ben.salve)}`);
  parts.push(`<h3>Tincture</h3>${ul(ben.tincture)}`);
  parts.push(`<h3>Other</h3>${ul(ben.other)}`);

  function recipe(obj){
    if (!obj) return `<p><em>No details.</em></p>`;
    const ing = obj.ingredients?.length ? `<h4>Ingredients</h4><ul>${obj.ingredients.map(x=>`<li>${htmlEsc(x)}</li>`).join('')}</ul>`:'';
    const steps = obj.steps?.length ? `<h4>Steps</h4><ol>${obj.steps.map(x=>`<li>${htmlEsc(x)}</li>`).join('')}</ol>`:'';
    const ideas = obj.ideas?.length ? `<h4>Ideas</h4><ul>${obj.ideas.map(x=>`<li>${htmlEsc(x)}</li>`).join('')}</ul>`:'';
    return [ing,steps,ideas].filter(Boolean).join('');
  }

  parts.push(`<h2>Ways to Prepare</h2>`);
  parts.push(`<h3>Tea</h3>${recipe(prep.tea)}`);
  parts.push(`<h3>Salve</h3>${recipe(prep.salve)}`);
  parts.push(`<h3>Culinary</h3>${recipe(prep.culinary)}`);
  parts.push(`<h3>Tincture</h3>${recipe(prep.tincture)}`);

  parts.push(`<h2>Safety</h2>${ul(article.safety)}`);

  if (article.sources?.length){
    parts.push(`<h2>Sources</h2><ul>${article.sources.map(x=>`<li>${htmlEsc(x)}</li>`).join('')}</ul>`);
  }

  parts.push(`<p><small>This is educational information, not medical advice.</small></p>`);
  return parts.join('\n');
}

(async function main(){
  const used = readJSONSafe(USED_PLANTS_PATH, []); // array of plant_key strings
  const dateISO = todayISO();

  const prompt = [
    "Return STRICT JSON only with the schema below. Choose a RANDOM commonly known plant NOT in EXCLUSIONS.",
    "Tone: neutral, educational; avoid medical claims (“traditionally used”, “studies suggest”).",
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
    '  },',
    '  "safety": ["string"],',
    '  "image": { "url":"string", "license":"string", "credit":"string", "source":"string" },',
    '  "sources": ["string"]',
    "}",
    "",
    `EXCLUSIONS: ${JSON.stringify(used)}`
  ].join('\n');

  const article = await openaiJSON(prompt);

  const plantKey = article.plant_key || `${article.common_name} | ${article.scientific_name||''}`.trim();
  if (used.includes(plantKey)) throw new Error('Model returned excluded plant; rerun to try again.');

  // Build target schema for articles.json
  const title = `${article.common_name}: Uses, History, and Preparations`;
  const idBase = slugify(title);
  let id = idBase;

  // Ensure unique id in articles.json
  const articles = readJSONSafe(ARTICLES_PATH, []);
  if (!Array.isArray(articles)) throw new Error('articles.json is not an array.');
  const existingIds = new Set(articles.map(a => a.id));
  let suffix = 1;
  while (existingIds.has(id)) { id = `${idBase}-${++suffix}`; }

  const imageUrl = (article.image && article.image.url) ? String(article.image.url) : "";

  const bodyHTML = buildHTML(article);

  const record = {
    id,
    title,
    excerpt: clamp(article.short_history || `Daily insight on ${article.common_name}.`, 300),
    author: "Staff Writer",
    date: dateISO,
    image: imageUrl,                      // keep empty string if you prefer to add later
    tag: "plant",
    tags: ["plants","herbal","daily insight", slugify(article.common_name)],
    body: bodyHTML
  };

  // Append newest first
  articles.unshift(record);
  writeJSON(ARTICLES_PATH, articles);

  // Update used history
  used.push(plantKey);
  writeJSON(USED_PLANTS_PATH, used);

  console.log(`Added ${article.common_name} -> articles.json (id: ${id})`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
