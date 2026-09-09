/**
 * Retrieval adapters.
 *
 * Each adapter turns a configured source into a list of normalised candidate
 * records. Nothing here invents content: every field is copied from the
 * upstream feed or API, and every record carries the URL it came from.
 *
 * Adding a new kind of source means adding one function to ADAPTERS.
 */
import { XMLParser } from 'fast-xml-parser';
import { stripHtml, normaliseDate, truncate } from '../lib/text.js';

const UA = process.env.PERIPHERY_USER_AGENT
  || 'PERIPHERY/1.0 (personal research observatory; contact via site owner)';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  trimValues: true,
  processEntities: true
});

const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = v => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') return String(v['#text'] ?? '');
  return '';
};

async function get(url, { accept = 'application/xml, text/xml, */*' } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.FETCH_TIMEOUT_MS || 20000));
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

/** Blank record with every field the ingestion layer expects. */
function record(partial) {
  return {
    title: '', abstract: '', url: '', canonical_id: null, authors: null,
    publication_date: null, publication_type: 'article',
    peer_review_status: 'unknown', open_access: 0, word_estimate: null,
    ...partial
  };
}

// ---------------------------------------------------------------------------
// RSS 2.0 / Atom — covers journals, magazines, institutional newsrooms, blogs
// ---------------------------------------------------------------------------
async function feed(source) {
  const xml = await get(source.url);
  const doc = parser.parse(xml);

  if (doc?.rss?.channel) {
    return arr(doc.rss.channel.item).map(it => {
      const link = txt(it.link) || txt(it['atom:link']?.['@href']) || txt(it.guid);
      const body = it['content:encoded'] || it.description || '';
      return record({
        title: stripHtml(txt(it.title)),
        abstract: stripHtml(txt(body)),
        url: link,
        canonical_id: txt(it['dc:identifier']) || txt(it.guid) || link,
        authors: stripHtml(txt(it['dc:creator']) || txt(it.author)) || null,
        publication_date: normaliseDate(txt(it.pubDate) || txt(it['dc:date'])),
        word_estimate: stripHtml(txt(body)).split(/\s+/).filter(Boolean).length || null
      });
    });
  }

  if (doc?.feed) {
    return arr(doc.feed.entry).map(e => {
      const links = arr(e.link);
      const alt = links.find(l => (l['@rel'] ?? 'alternate') === 'alternate') || links[0];
      const body = txt(e.content) || txt(e.summary);
      return record({
        title: stripHtml(txt(e.title)),
        abstract: stripHtml(body),
        url: alt?.['@href'] || txt(e.id),
        canonical_id: txt(e.id),
        authors: arr(e.author).map(a => txt(a.name)).filter(Boolean).join(', ') || null,
        publication_date: normaliseDate(txt(e.published) || txt(e.updated)),
        word_estimate: stripHtml(body).split(/\s+/).filter(Boolean).length || null
      });
    });
  }

  if (doc?.['rdf:RDF']) { // RSS 1.0, still used by some journals
    return arr(doc['rdf:RDF'].item).map(it => record({
      title: stripHtml(txt(it.title)),
      abstract: stripHtml(txt(it.description)),
      url: txt(it.link),
      canonical_id: txt(it['dc:identifier']) || txt(it.link),
      authors: stripHtml(txt(it['dc:creator'])) || null,
      publication_date: normaliseDate(txt(it['dc:date']))
    }));
  }

  throw new Error('Unrecognised feed format');
}

// ---------------------------------------------------------------------------
// arXiv API — Atom with arXiv extensions. Everything here is a preprint.
// ---------------------------------------------------------------------------
async function arxiv(source) {
  const xml = await get(source.url);
  const doc = parser.parse(xml);
  return arr(doc?.feed?.entry).map(e => {
    const links = arr(e.link);
    const abs = links.find(l => l['@type'] === 'text/html')?.['@href'] || txt(e.id);
    const pdf = links.find(l => l['@title'] === 'pdf')?.['@href'] || null;
    return record({
      title: stripHtml(txt(e.title)),
      abstract: stripHtml(txt(e.summary)),
      url: abs,
      pdf_url: pdf,
      canonical_id: txt(e.id),
      authors: arr(e.author).map(a => txt(a.name)).filter(Boolean).join(', ') || null,
      publication_date: normaliseDate(txt(e.published)),
      publication_type: 'preprint',
      peer_review_status: 'preprint',
      open_access: 1,
      primary_subject: e['arxiv:primary_category']?.['@term'] || null,
      word_estimate: 7000 // typical arXiv paper; refined if full text is available
    });
  });
}

// ---------------------------------------------------------------------------
// bioRxiv / medRxiv JSON API
// ---------------------------------------------------------------------------
async function biorxiv(source) {
  const json = JSON.parse(await get(source.url, { accept: 'application/json' }));
  return arr(json.collection).map(p => record({
    title: stripHtml(p.title || ''),
    abstract: stripHtml(p.abstract || ''),
    url: p.doi ? `https://doi.org/${p.doi}` : (p.link || ''),
    canonical_id: p.doi || null,
    authors: p.authors || null,
    publication_date: normaliseDate(p.date),
    publication_type: 'preprint',
    peer_review_status: 'preprint',
    open_access: 1,
    primary_subject: p.category || null,
    word_estimate: 7000
  }));
}

// ---------------------------------------------------------------------------
// Crossref — peer-reviewed literature metadata
// ---------------------------------------------------------------------------
async function crossref(source) {
  const json = JSON.parse(await get(source.url, { accept: 'application/json' }));
  return arr(json?.message?.items).map(w => {
    const d = w.issued?.['date-parts']?.[0] || w.created?.['date-parts']?.[0] || [];
    return record({
      title: stripHtml(arr(w.title)[0] || ''),
      abstract: stripHtml(w.abstract || ''),
      url: w.URL || (w.DOI ? `https://doi.org/${w.DOI}` : ''),
      canonical_id: w.DOI || null,
      authors: arr(w.author).map(a => [a.given, a.family].filter(Boolean).join(' ')).join(', ') || null,
      publication_date: d.length ? normaliseDate(`${d[0]}-${String(d[1] || 1).padStart(2, '0')}-${String(d[2] || 1).padStart(2, '0')}`) : null,
      publication_type: w.type === 'journal-article' ? 'paper' : (w.type === 'book-chapter' ? 'book_chapter' : 'paper'),
      peer_review_status: 'peer_reviewed',
      open_access: w.license?.length ? 1 : 0,
      container: arr(w['container-title'])[0] || null,
      word_estimate: 7000
    });
  });
}

// ---------------------------------------------------------------------------
// PubMed — two-step esearch then esummary
// ---------------------------------------------------------------------------
async function pubmed(source) {
  const search = JSON.parse(await get(source.url, { accept: 'application/json' }));
  const ids = search?.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const key = process.env.NCBI_API_KEY ? `&api_key=${process.env.NCBI_API_KEY}` : '';
  const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}${key}`;
  const sum = JSON.parse(await get(sumUrl, { accept: 'application/json' }));
  return ids.map(id => {
    const r = sum?.result?.[id];
    if (!r) return null;
    const doi = arr(r.articleids).find(a => a.idtype === 'doi')?.value || null;
    return record({
      title: stripHtml(r.title || ''),
      abstract: '', // esummary carries no abstract; efetch is used lazily on approval
      url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      canonical_id: doi || `pmid:${id}`,
      authors: arr(r.authors).map(a => a.name).filter(Boolean).join(', ') || null,
      publication_date: normaliseDate(r.sortpubdate || r.pubdate),
      publication_type: 'paper',
      peer_review_status: 'peer_reviewed',
      container: r.fulljournalname || r.source || null,
      word_estimate: 6000
    });
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Generic JSON feed (jsonfeed.org) — used by a number of essay publications
// ---------------------------------------------------------------------------
async function jsonfeed(source) {
  const json = JSON.parse(await get(source.url, { accept: 'application/json' }));
  return arr(json.items).map(i => record({
    title: stripHtml(i.title || ''),
    abstract: stripHtml(i.content_text || i.content_html || i.summary || ''),
    url: i.url || i.external_url || '',
    canonical_id: i.id || i.url,
    authors: i.author?.name || arr(i.authors).map(a => a.name).join(', ') || null,
    publication_date: normaliseDate(i.date_published),
    word_estimate: stripHtml(i.content_text || i.content_html || '').split(/\s+/).filter(Boolean).length || null
  }));
}

export const ADAPTERS = {
  rss: feed, atom: feed, feed,
  arxiv, biorxiv, medrxiv: biorxiv,
  crossref, pubmed, json: jsonfeed
};

/** WordPress feeds append "The post X appeared first on Y" to every summary. */
function stripFeedBoilerplate(text = '') {
  return String(text)
    .replace(/\s*The post .*? appeared first on .*?\.?\s*$/i, '')
    .replace(/\s*Continue reading\s*[\u2026.]*\s*$/i, '')
    // Aeon and Psyche end every teaser with a byline trailer:
    // "- by Author Name Read on Psyche" / "Watch on Aeon" / "Listen on \u2026"
    .replace(/\s*-\s*by\s+.+?\s+(?:Read|Watch|Listen)\s+on\s+\S+\.?\s*$/i, '')
    .trim();
}

/**
 * Retrieve one source. Returns { ok, items, error }.
 * Never throws — a broken source must not take down a run.
 */
export async function fetchSource(source) {
  const adapter = ADAPTERS[source.kind];
  if (!adapter) return { ok: false, items: [], error: `No adapter for kind "${source.kind}"` };
  try {
    // A publication's feed often carries more than the thing you subscribed for
    // — Psyche mixes films in with its essays. This drops them at the door.
    let drop = null;
    if (source.exclude_pattern) {
      try { drop = new RegExp(source.exclude_pattern, 'i'); }
      catch { /* a bad pattern must not break the run */ }
    }
    const items = (await adapter(source))
      .filter(i => i.title && i.url)
      .filter(i => !(drop && drop.test(i.url)))
      .map(i => ({ ...i, abstract: truncate(stripFeedBoilerplate(i.abstract), 4000) }));
    return { ok: true, items, error: null };
  } catch (err) {
    return { ok: false, items: [], error: err.message };
  }
}
