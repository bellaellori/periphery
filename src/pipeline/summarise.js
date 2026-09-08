/**
 * Editorial summarisation.
 *
 * Two paths:
 *
 *  1. MODEL — if ANTHROPIC_API_KEY is set, the abstract and metadata that were
 *     actually retrieved are sent to a model with a strict brief: answer the six
 *     editorial questions, preserve uncertainty, distinguish finding from
 *     interpretation from speculation, and invent nothing. If the source
 *     material does not support a field, the model must return null for it.
 *
 *  2. EXTRACTIVE — with no key, the summary is built by selecting sentences from
 *     the retrieved abstract. It is plainer, but it is the source's own words
 *     and it cannot hallucinate.
 *
 * Either way the original piece stays the primary reading experience: we store
 * metadata, a summary and a link, never a reproduction of the article.
 */
import { sentences, truncate, stripHtml } from '../lib/text.js';

const MODEL = process.env.PERIPHERY_MODEL || 'claude-sonnet-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

export function summariserName() {
  return process.env.ANTHROPIC_API_KEY ? `model:${MODEL}` : 'extractive';
}

const SYSTEM = `You are the desk editor of PERIPHERY, a serious intellectual magazine covering science, research and ideas.

You will be given metadata and an abstract that were retrieved from a real source. Write the editorial apparatus around that piece.

Absolute rules:
- Use ONLY the supplied material. Never add a finding, number, author, institution, citation or claim that is not present in it.
- If the supplied material does not support a field, return null for that field. A null is always better than an invention.
- Preserve uncertainty. Distinguish clearly between what was measured (finding), what the authors take it to mean (interpretation), and what would only be a guess (speculation). Label interpretation and speculation as such in the prose.
- No sensationalism. No "breakthrough", "revolutionary", "game-changing", "scientists baffled". No implied clinical advice.
- Note the limits that are visible in the material: sample size, model organism, preprint status, correlational design, single site, self-report.
- British spelling. Restrained, precise, unhurried prose. Write as a magazine, not as a press release.

Return ONLY a JSON object with these keys:
{
  "dek": "one sentence standfirst, under 160 characters, no full stop needed",
  "short_summary": "1-2 sentences for an index page",
  "research_summary": "2-4 paragraphs of substantive summary, separated by \\n\\n",
  "what_happened": "one short paragraph",
  "what_they_did": "the actual method, as specifically as the material allows",
  "what_they_found": "the result, stated as a finding",
  "evidence_strength": "an honest assessment of how much weight this can bear, naming the design and its limits",
  "why_interesting": "one paragraph",
  "broader_question": "the larger open question this connects to",
  "why_it_matters": "one short paragraph",
  "connection_to_research": "how it bears on the reader's stated research interests, or null if it does not",
  "concepts": ["3-7 concept tags, lowercase, each 1-3 words"]
}`;

const LONGFORM_EXTRA = `
This piece is being selected for THE LONG READ, where the original is the reading experience and your text is only the approach to it. Also return:
  "selection_rationale": "why this was chosen for the reader, specifically",
  "intellectual_territory": "what ground it covers",
  "concepts_raised": "the useful concepts and questions it puts in play"
Keep the summary fields shorter than usual here: do not substitute for reading it.`;

async function callModel(payload, { longForm }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM + (longForm ? LONGFORM_EXTRA : ''),
      messages: [{ role: 'user', content: JSON.stringify(payload) }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${truncate(await res.text(), 300)}`);
  const body = await res.json();
  const text = (body.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Model returned no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Extractive fallback. Uses the abstract's own sentences, and states plainly
 * where the material does not answer a question.
 */
function extractive(item, { relevance } = {}) {
  const abs = stripHtml(item.abstract || '');
  const ss = sentences(abs);
  const pick = (from, to) => ss.slice(from, to).join(' ') || null;

  const preprint = item.peer_review_status === 'preprint';
  const design = [
    /randomis|randomiz|placebo|double-blind/i.test(abs) && 'a randomised design',
    /cohort|longitudinal|follow-up/i.test(abs) && 'a cohort or longitudinal design',
    /correlat|associat|cross-sectional/i.test(abs) && 'an associational design',
    /simulat|model|in silico/i.test(abs) && 'modelling or simulation',
    /mice|mouse|rat|zebrafish|drosophila|in vitro/i.test(abs) && 'a non-human or in-vitro system',
    /meta-analysis|systematic review/i.test(abs) && 'evidence synthesis'
  ].filter(Boolean);

  const n = abs.match(/\bn\s*=\s*([\d,]+)/i)?.[1];

  const strength = [
    design.length ? `The abstract indicates ${design.join(' and ')}.` : 'The abstract does not state the design in enough detail to judge it.',
    n ? `A sample of n = ${n} is reported.` : null,
    preprint
      ? 'This is a preprint and has not been through peer review; treat the claims as provisional.'
      : (item.peer_review_status === 'peer_reviewed' ? 'Published in a peer-reviewed venue.' : null),
    'This assessment was generated without a language model, from the abstract alone — read the original before relying on it.'
  ].filter(Boolean).join(' ');

  return {
    dek: truncate(ss[0] || item.title, 150),
    short_summary: truncate(ss.slice(0, 2).join(' ') || abs, 300),
    research_summary: [pick(0, 3), pick(3, 7)].filter(Boolean).join('\n\n') || truncate(abs, 900) || null,
    what_happened: pick(0, 1),
    what_they_did: ss.find(s => /we |study|experiment|method|measur|analys|participants|sample|model/i.test(s)) || null,
    what_they_found: ss.find(s => /found|show|demonstrat|result|observ|report|reveal|associated/i.test(s)) || null,
    evidence_strength: strength,
    why_interesting: null,
    broader_question: null,
    why_it_matters: null,
    connection_to_research: relevance?.relevance_rationale || null,
    concepts: [],
    selection_rationale: relevance?.relevance_rationale || null,
    intellectual_territory: null,
    concepts_raised: null
  };
}

/**
 * Produce the editorial apparatus for one item.
 * Always resolves; falls back to extractive if the model path fails.
 */
export async function summarise(item, { longForm = false, relevance = null, profileStatement = '' } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ...extractive(item, { relevance }), summary_provenance: 'extractive' };
  }
  const payload = {
    title: item.title,
    authors: item.authors,
    source: item.source_name,
    source_url: item.url || item.source_url,
    publication_date: item.publication_date,
    publication_type: item.publication_type,
    peer_review_status: item.peer_review_status,
    abstract_or_excerpt: truncate(item.abstract || '', 6000),
    reader_research_profile: truncate(profileStatement, 1200),
    why_the_system_surfaced_it: relevance?.relevance_rationale || null
  };
  try {
    const out = await callModel(payload, { longForm });
    return { ...out, summary_provenance: 'model' };
  } catch (err) {
    return {
      ...extractive(item, { relevance }),
      summary_provenance: 'extractive',
      _error: err.message
    };
  }
}
