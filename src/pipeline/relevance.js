/**
 * Relevance assessment — and the PERIPHERY PRINCIPLE.
 *
 * Two scores are computed for every candidate:
 *
 *   direct    — how well it matches what the reader has said they work on
 *   bridge    — how well it matches a *neighbouring* vocabulary for one of
 *               those concerns, in a field the reader did not name
 *
 * A piece with a high direct score is core reading. A piece with a low direct
 * score but a strong bridge is a periphery pick: the same problem wearing a
 * different discipline's clothes. Those are the ones the reader would not have
 * found by searching their own terms, and every edition reserves room for them.
 *
 * Nothing in this file names a subject the reader cares about. The vocabulary
 * comes from research_interests and concept_adjacency, both editable in the UI.
 */
import { fold, stemTokens } from '../lib/text.js';
import { db, profile, interests } from '../db/index.js';

const KIND_WEIGHT = { topic: 1.0, concept: 0.85, field: 0.5, author: 1.2, source: 0.4, project: 1.1 };

// A term is "core" at this much direct score, "periphery" at this much bridge.
const CORE_THRESHOLD = 3.0;
const ADJACENT_THRESHOLD = 1.0;
const BRIDGE_THRESHOLD = 1.2;

/**
 * How strongly a phrase appears in a text, matched on stems so that
 * "homeostasis" finds "homeostatic" and "regulation" finds "regulatory".
 *
 * A multi-word phrase scores fully when its words appear consecutively, and
 * partially when they all appear but scattered — "biological regulation" should
 * still register in a piece about "regulation in biological systems", just less
 * loudly than in one that uses the phrase itself.
 */
function phraseHits(hayStems, phrase) {
  const want = stemTokens(phrase);
  if (!want.length || (want.length === 1 && want[0].length < 4)) return 0;

  let consecutive = 0;
  for (let i = 0; i <= hayStems.length - want.length; i++) {
    let match = true;
    for (let j = 0; j < want.length; j++) {
      if (hayStems[i + j] !== want[j]) { match = false; break; }
    }
    if (match) consecutive++;
  }

  const specificity = 1 + (want.length - 1) * 0.6;
  if (consecutive) return Math.min(consecutive, 3) * specificity;

  if (want.length > 1) {
    const present = new Set(hayStems);
    if (want.every(w => present.has(w))) return 0.7 * specificity;
  }
  return 0;
}

export function loadProfileModel() {
  const p = profile();
  const rows = interests({ activeOnly: true });
  const byKind = k => rows.filter(r => r.kind === k);

  const positive = rows
    .filter(r => r.kind !== 'avoid')
    .map(r => ({ ...r, w: (KIND_WEIGHT[r.kind] ?? 0.6) * (r.weight ?? 1) }));

  const adjacency = db.prepare('SELECT * FROM concept_adjacency').all();

  return {
    profile: p,
    positive,
    avoid: byKind('avoid').map(r => r.value),
    authors: byKind('author').map(r => r.value),
    watchedSources: byKind('source').map(r => r.value),
    projects: byKind('project'),
    adjacency,
    statementTerms: (p?.statement || '')
      .split(/[,;.\n]/).map(s => s.trim()).filter(s => s.length > 5).slice(0, 24)
  };
}

/**
 * Score one candidate against the profile model.
 * Returns everything needed to explain the decision to the reader.
 */
export function assess(item, model, { sourceName = '' } = {}) {
  const hay = stemTokens(`${item.title} ${item.dek || ''} ${item.abstract || item.short_summary || ''} ${item.category || ''}`);
  const authorStems = stemTokens(item.authors || '');

  // --- avoid list: a hard veto, not a penalty ---
  for (const a of model.avoid) {
    if (phraseHits(hay, a) > 0) {
      return {
        relevance_score: 0, relevance_status: 'background',
        is_periphery_pick: 0, periphery_bridge: null,
        relevance_rationale: `Excluded: matches an avoided topic ("${a}").`,
        excluded: true, matched: [], bridges: []
      };
    }
  }

  // --- direct match ---
  let direct = 0;
  const matched = [];
  for (const r of model.positive) {
    const hits = phraseHits(hay, r.value);
    if (hits > 0) { direct += hits * r.w; matched.push({ kind: r.kind, value: r.value, hits }); }
  }
  for (const s of model.statementTerms) {
    const hits = phraseHits(hay, s);
    if (hits > 0) direct += hits * 0.35;
  }
  for (const a of model.authors) {
    if (authorStems.length && phraseHits(authorStems, a) > 0) {
      direct += 3; matched.push({ kind: 'author', value: a, hits: 1 });
    }
  }
  const sourceStems = stemTokens(sourceName);
  for (const s of model.watchedSources) {
    if (phraseHits(sourceStems, s) > 0) direct += 0.8;
  }

  // --- bridge match: adjacent vocabulary for a concept the reader holds ---
  const bridges = [];
  const heldTerms = new Set(model.positive.map(r => fold(r.value)));
  for (const link of model.adjacency) {
    if (!heldTerms.has(fold(link.concept))) continue;      // only bridge from live concerns
    const hits = phraseHits(hay, link.adjacent);
    if (hits > 0) {
      bridges.push({ ...link, hits, contribution: hits * link.strength });
    }
  }
  bridges.sort((a, b) => b.contribution - a.contribution);
  const bridge = bridges.reduce((s, b) => s + b.contribution, 0);

  // --- combine ---
  const score = Number((direct + bridge * 0.8).toFixed(3));

  // Order matters. A piece that is squarely on the profile is core even if a
  // bridge also fires; a piece the bridges found is a periphery pick even when
  // it brushes the profile's own vocabulary in passing — what makes it a
  // periphery find is that the sideways route carried more of the weight.
  let status, isPeriphery = 0, bridgeNote = null;
  if (direct >= CORE_THRESHOLD) {
    status = 'core';
  } else if (bridge >= BRIDGE_THRESHOLD && bridge >= direct * 0.9) {
    status = 'periphery';
    isPeriphery = 1;
    const top = bridges[0];
    bridgeNote = `${top.field || 'an adjacent field'} → ${top.concept}`;
  } else if (direct >= ADJACENT_THRESHOLD || bridge > 0) {
    status = 'adjacent';
  } else {
    status = 'background';
  }

  return {
    relevance_score: score,
    relevance_status: status,
    is_periphery_pick: isPeriphery,
    periphery_bridge: bridgeNote,
    relevance_rationale: explain({ status, matched, bridges, direct, bridge }),
    excluded: false,
    matched,
    bridges
  };
}

function list(xs, n = 3) {
  const u = [...new Set(xs)].slice(0, n);
  if (u.length <= 1) return u[0] || '';
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`;
}

function explain({ status, matched, bridges }) {
  const direct = list(matched.filter(m => m.kind !== 'author').map(m => m.value));
  const authors = list(matched.filter(m => m.kind === 'author').map(m => m.value));

  if (status === 'core') {
    return `Sits directly on ${direct || 'stated research ground'}${authors ? `; author match: ${authors}` : ''}.`;
  }
  if (status === 'periphery') {
    const b = bridges[0];
    const others = list(bridges.slice(1, 3).map(x => x.adjacent));
    return `Found through the periphery: little or no direct keyword overlap, but "${b.adjacent}"`
      + `${b.field ? ` in ${b.field}` : ''} is a neighbouring treatment of ${b.concept}`
      + `${others ? `, alongside ${others}` : ''}.`;
  }
  if (status === 'adjacent') {
    if (direct) return `Partial overlap with ${direct}.`;
    if (bridges.length) return `Touches ${bridges[0].concept} through ${bridges[0].adjacent}.`;
    return 'Loose overlap with the current profile.';
  }
  return 'No overlap with the current profile; held as background.';
}

/** Re-assess everything in the library — used after the profile is edited. */
export function reassessAll() {
  const model = loadProfileModel();
  const rows = db.prepare(`
    SELECT a.*, s.name AS s_name FROM articles a
    LEFT JOIN sources s ON s.id = a.source_id
  `).all();
  const upd = db.prepare(`
    UPDATE articles SET relevance_score = ?, relevance_status = ?, is_periphery_pick = ?,
      periphery_bridge = ?, relevance_rationale = ?, updated_at = datetime('now')
    WHERE id = ?`);
  const tx = db.transaction(items => {
    for (const a of items) {
      const r = assess(
        { ...a, abstract: [a.short_summary, a.research_summary, a.dek].filter(Boolean).join(' ') },
        model,
        { sourceName: a.s_name || a.source_name }
      );
      upd.run(r.relevance_score, r.relevance_status, r.is_periphery_pick,
        r.periphery_bridge, r.relevance_rationale, a.id);
    }
  });
  tx(rows);
  return rows.length;
}
