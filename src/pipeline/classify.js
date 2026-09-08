/**
 * Classification.
 *
 * This is a *taxonomy*, not a statement about the reader's interests. It maps
 * incoming material onto the sections a publication needs. The reader's own
 * interests live entirely in the research_profile / research_interests tables
 * and are edited from the interface.
 */
import { fold, readingTime, words } from '../lib/text.js';

export const CATEGORIES = {
  biology:            { label: 'Biology',              cues: ['cell', 'gene', 'genome', 'protein', 'organism', 'metabolic', 'physiolog', 'molecular', 'enzyme', 'tissue', 'developmental biology', 'microbiome'] },
  neuroscience:       { label: 'Neuroscience',         cues: ['neuron', 'neural', 'brain', 'cortex', 'cortical', 'synap', 'hippocamp', 'dopamin', 'interocept', 'neuroimag', 'eeg', 'fmri', 'connectome'] },
  psychology:         { label: 'Psychology',           cues: ['psycholog', 'emotion', 'affect', 'motivation', 'personality', 'wellbeing', 'stress', 'trauma', 'attachment', 'developmental psych'] },
  cognition:          { label: 'Cognition',            cues: ['cognit', 'perception', 'attention', 'memory', 'reasoning', 'inference', 'predictive processing', 'learning', 'decision-making', 'metacognit'] },
  systems:            { label: 'Systems & Complexity', cues: ['complex system', 'emergen', 'self-organis', 'self-organiz', 'nonlinear', 'dynamical system', 'attractor', 'phase transition', 'criticality', 'systems theory', 'cybernetic'] },
  regulation:         { label: 'Regulation & Control', cues: ['homeostat', 'allostat', 'regulat', 'feedback', 'control theory', 'setpoint', 'set point', 'closure', 'termination', 'negative feedback', 'controller'] },
  distributed:        { label: 'Distributed Systems',  cues: ['distributed', 'consensus', 'multi-agent', 'swarm', 'decentralis', 'decentraliz', 'coordination', 'network topology', 'peer-to-peer'] },
  medicine:           { label: 'Medicine & Physiology',cues: ['clinical', 'patient', 'trial', 'therapy', 'diagnos', 'disease', 'immun', 'cardio', 'inflammat', 'physiolog', 'epidemiolog', 'autonomic'] },
  behaviour:          { label: 'Behavioural Science',  cues: ['behaviour', 'behavior', 'incentive', 'nudge', 'choice', 'habit', 'experiment with participants', 'field experiment', 'preregistered'] },
  sociology:          { label: 'Sociology',            cues: ['social', 'societ', 'institution', 'inequality', 'demograph', 'labour', 'labor market', 'community', 'norms', 'organis', 'organiz'] },
  technology:         { label: 'Technology & AI',      cues: ['machine learning', 'artificial intelligence', 'language model', 'algorithm', 'computation', 'software', 'robot', 'semiconduct', 'neural network'] },
  philosophy:         { label: 'Philosophy of Science',cues: ['philosoph', 'epistem', 'ontolog', 'explanation', 'causation', 'reduction', 'scientific method', 'replication crisis', 'theory-laden'] },
  ecology:            { label: 'Ecology & Environment',cues: ['ecosystem', 'ecolog', 'species', 'biodiversity', 'climate', 'forest', 'ocean', 'population dynamics', 'trophic'] },
  mathematics:        { label: 'Mathematics & Information', cues: ['information theory', 'entropy', 'bayesian', 'probabil', 'topolog', 'graph theory', 'statistic', 'theorem', 'proof'] },
  anthropology:       { label: 'Anthropology & History', cues: ['anthropolog', 'archaeolog', 'ethnograph', 'prehistor', 'material culture', 'historical record', 'kinship'] },
  general:            { label: 'Ideas',                cues: [] }
};

export const CATEGORY_LABELS = Object.fromEntries(
  Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])
);

const PUBLICATION_CUES = [
  [/\b(systematic review|meta-analysis|review article|narrative review)\b/i, 'review'],
  [/\b(preprint|biorxiv|medrxiv|arxiv|ssrn)\b/i, 'preprint'],
  [/\b(essay|reflections on|in defence of|in defense of)\b/i, 'essay'],
  [/\b(investigation|investigative|revealed by documents)\b/i, 'investigation'],
  [/\b(report|white paper|working paper)\b/i, 'report']
];

/** Assign a category from title + abstract, honouring an explicit source default. */
export function categorise(item, source) {
  const hay = fold(`${item.title} ${item.abstract || ''} ${item.primary_subject || ''}`);
  let best = null, bestScore = 0;
  for (const [key, def] of Object.entries(CATEGORIES)) {
    let score = 0;
    for (const cue of def.cues) {
      const f = fold(cue);
      if (!f) continue;
      // count occurrences, cheaply
      let idx = 0, n = 0;
      while ((idx = hay.indexOf(f, idx)) !== -1) { n++; idx += f.length; }
      if (n) score += 1 + Math.min(n - 1, 2) * 0.4;
    }
    if (score > bestScore) { bestScore = score; best = key; }
  }
  if (!best && source?.default_category) return source.default_category;
  return best || source?.default_category || 'general';
}

/** Infer publication type and review status where the source has not told us. */
export function typify(item, source) {
  let type = item.publication_type || 'article';
  let review = item.peer_review_status || 'unknown';

  if (type === 'article' || review === 'unknown') {
    const hay = `${item.title} ${item.abstract || ''} ${item.url}`;
    for (const [re, t] of PUBLICATION_CUES) {
      if (re.test(hay)) { type = t; break; }
    }
  }
  if (review === 'unknown') {
    if (type === 'preprint') review = 'preprint';
    else if (source?.publisher_type === 'journal') review = 'peer_reviewed';
    else if (source?.publisher_type === 'preprint') review = 'preprint';
    else if (['essay', 'investigation', 'article'].includes(type)) review = 'not_applicable';
  }
  return { publication_type: type, peer_review_status: review };
}

/** Estimated reading time for the ORIGINAL piece, not for our summary. */
export function estimateReading(item, publication_type) {
  const n = item.word_estimate || words(item.abstract || '').length * 12 || 1200;
  return { word_estimate: n, reading_time_min: readingTime(n, publication_type) };
}

/**
 * Long-form test. A long read is something substantial enough to sit down with:
 * a full paper, a review, an essay of real length.
 */
export function isLongForm({ publication_type, word_estimate }) {
  if (['paper', 'preprint', 'review', 'book_chapter'].includes(publication_type)) return true;
  return (word_estimate || 0) >= 2500;
}
