/**
 * daily_insurance_article.js
 * - Calls an LLM with a strict JSON prompt to generate an insurance article
 * - Fetches a CC0/Public Domain image from Openverse
 * - Appends to ./articles.json (array) and sorts newest → oldest
 *
 * Requires: Node 18+ (for global fetch)
 * Env:
 *  - OPENAI_API_KEY=...   (if using OpenAI)
 *  - LLM_MODEL=gpt-4o-mini (optional override)
 *
 * Files:
 *  - ./articles.json   (array of articles used by your site)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const outDir  = path.join(process.cwd(), "docs", "insurance", "data");
const ARTICLES_PATH = path.resolve(outDir, 'articles.json');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

// --- Helpers ---------------------------------------------------------------

const todayISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function readArticles() {
  if (!fs.existsSync(ARTICLES_PATH)) return [];
  try {
    const txt = fs.readFileSync(ARTICLES_PATH, 'utf8').trim();
    return txt ? JSON.parse(txt) : [];
  } catch (e) {
    console.error('Failed to read/parse articles.json:', e.message);
    return [];
  }
}

function writeArticles(list) {
  fs.writeFileSync(ARTICLES_PATH, JSON.stringify(list, null, 2), 'utf8');
  console.log(`Updated ${ARTICLES_PATH} (${list.length} articles)`);
}

// Remove possible code fences from LLM responses
function stripFences(s) {
  return s.replace(/^```(?:json)?\s*|\s*```$/g, '');
}

// --- Build the LLM prompt --------------------------------------------------

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

Image Sourcing & Validation:
- DO NOT invent URLs or include copyrighted material.
- Return 3 descriptive image_keywords suitable for searching CC0/public-domain sources (e.g., Openverse, Pixabay Public Domain).
- Each image must:
  1. Be valid and retrievable (no 404 or invalid files)
  2. Contain no public personalities or branded elements
  3. Not duplicate images used in previous articles
  4. Be high-resolution and visually relevant to the topic
  5. Match a professional, neutral insurance tone

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
  "image_keywords": ["kw1","kw2","kw3"],
  "body_html": "<p>Full HTML article…</p>"
}
`.trim();
}


// --- Call the LLM (OpenAI example; swap out if you use another) ------------

async function generateArticleJSON() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing. Set it in your environment.');
  }
  const prompt = buildDailyPrompt();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: 'You are a careful, structured content generator that always returns strict JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      response_format: { type: 'json_object' }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  let content = data.choices?.[0]?.message?.content || '';
  content = stripFences(content);
  const obj = JSON.parse(content);

  // Normalize/guard fields
  obj.id = slugify(obj.id || obj.title || `insurance-${todayISO}`);
  obj.date = todayISO;
  obj.author ||= 'Staff Writer';
  obj.primary_tag ||= (obj.tags && obj.tags[0]) || 'Insurance';
  return obj;
}

// --- Fetch a CC0/Public Domain image from Openverse ------------------------
// Docs: Openverse indexes Creative Commons & public-domain media; you must verify license metadata.
// We filter to CC0 and Public Domain Mark where possible. :contentReference[oaicite:1]{index=1}
async function fetchCC0Image(keywords = []) {
  const base = 'https://api.openverse.org/v1/images';
  const queries = keywords.length ? keywords : ['insurance policy document', 'home exterior', 'car coverage concept'];

  for (const q of queries) {
    const url = new URL(base);
    url.searchParams.set('q', q);
    // Ask for CC0/public domain only
    url.searchParams.set('license', 'cc0,pdm'); // PDM = Public Domain Mark (if supported)
    url.searchParams.set('page_size', '5');

    const res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
    if (!res.ok) continue;
    const data = await res.json().catch(() => null);
    const item = data?.results?.find(Boolean);
    if (item) {
      // Prefer direct URL; keep landing URL and license metadata for attribution if you choose to display it.
      return {
        image: item.url || item.thumbnail || item.foreign_landing_url,
        attribution: {
          title: item.title || '',
          creator: item.creator || '',
          source: item.source || 'openverse',
          license: item.license || 'cc0',
          license_version: item.license_version || '',
          landing_url: item.foreign_landing_url || ''
        }
      };
    }
  }
  return null;
}

// --- Main ------------------------------------------------------------------

(async function main() {
  const articles = readArticles();

  // 1) Generate article JSON via LLM
  const draft = await generateArticleJSON();

  // 2) Get a CC0/Public Domain image
  const img = await fetchCC0Image(draft.image_keywords || []);
  if (img?.image) {
    draft.image = img.image;
    draft.image_attribution = img.attribution; // optional extra metadata
  } else {
    // Fallback placeholder (you could host a local CC0 image in /images/)
    draft.image = 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6e/Public_Domain_Mark_button.svg/512px-Public_Domain_Mark_button.svg.png';
  }

  // 3) Map to your site’s schema:
  //    - `tag` (primary) for the listing grid
  //    - `body` (HTML) for article page
  const record = {
    id: draft.id,
    title: draft.title,
    excerpt: draft.excerpt,
    author: draft.author,
    date: draft.date,
    image: draft.image,
    tag: draft.primary_tag,     // primary tag for grid
    tags: draft.tags || [],     // full tag set (optional, future use)
    body: draft.body_html       // used by article.html
  };

  // 4) De-dupe by id or same-title same-day
  const exists = articles.find(a => a.id === record.id) ||
                 articles.find(a => a.title === record.title && a.date === record.date);
  if (exists) {
    // Ensure uniqueness by suffixing the slug
    const suffix = crypto.randomBytes(2).toString('hex');
    record.id = `${record.id}-${suffix}`;
  }

  // 5) Append + sort newest → oldest
  const next = [record, ...articles].sort((a, b) => new Date(b.date) - new Date(a.date));
  writeArticles(next);

  console.log('Created article:', record.title, '→', record.id);
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
