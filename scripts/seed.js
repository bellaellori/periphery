#!/usr/bin/env node
/**
 * Seeding.
 *
 *   node scripts/seed.js sources     starter source list
 *   node scripts/seed.js profile     starter research profile + periphery map
 *   node scripts/seed.js demo        labelled demo articles and editions
 *   node scripts/seed.js all         all three
 *   node scripts/seed.js clear-demo  remove every demo item and demo edition
 *
 * Everything seeded here is editable from the interface. None of it is
 * privileged in the code.
 */
import { db, migrate } from '../src/db/index.js';
import { slugify, hash } from '../src/lib/text.js';

migrate();

// ---------------------------------------------------------------------------
// SOURCES
// ---------------------------------------------------------------------------
// A starting list of feeds and APIs. Verify each one after deploying — press
// "test" beside it in the editorial desk. A source that 404s is visible there
// within seconds and costs nothing; the pipeline skips it and carries on.
const SOURCES = [
  // Preprints — always labelled as such in the interface
  { name: 'arXiv · Neurons and Cognition', kind: 'arxiv', publisher_type: 'preprint', quality_tier: 1, default_category: 'neuroscience',
    url: 'http://export.arxiv.org/api/query?search_query=cat:q-bio.NC&start=0&max_results=40&sortBy=submittedDate&sortOrder=descending',
    homepage: 'https://arxiv.org/list/q-bio.NC/recent' },
  { name: 'arXiv · Adaptation and Self-Organising Systems', kind: 'arxiv', publisher_type: 'preprint', quality_tier: 1, default_category: 'systems',
    url: 'http://export.arxiv.org/api/query?search_query=cat:nlin.AO&start=0&max_results=40&sortBy=submittedDate&sortOrder=descending',
    homepage: 'https://arxiv.org/list/nlin.AO/recent' },
  { name: 'arXiv · Multiagent Systems', kind: 'arxiv', publisher_type: 'preprint', quality_tier: 1, default_category: 'distributed',
    url: 'http://export.arxiv.org/api/query?search_query=cat:cs.MA&start=0&max_results=30&sortBy=submittedDate&sortOrder=descending',
    homepage: 'https://arxiv.org/list/cs.MA/recent' },
  { name: 'arXiv · Systems and Control', kind: 'arxiv', publisher_type: 'preprint', quality_tier: 1, default_category: 'regulation',
    url: 'http://export.arxiv.org/api/query?search_query=cat:eess.SY&start=0&max_results=30&sortBy=submittedDate&sortOrder=descending',
    homepage: 'https://arxiv.org/list/eess.SY/recent' },
  { name: 'bioRxiv · Neuroscience', kind: 'rss', publisher_type: 'preprint', quality_tier: 1, default_category: 'neuroscience',
    url: 'https://connect.biorxiv.org/biorxiv_xml.php?subject=neuroscience', homepage: 'https://www.biorxiv.org' },
  { name: 'bioRxiv · Systems Biology', kind: 'rss', publisher_type: 'preprint', quality_tier: 1, default_category: 'biology',
    url: 'https://connect.biorxiv.org/biorxiv_xml.php?subject=systems_biology', homepage: 'https://www.biorxiv.org' },
  { name: 'PsyArXiv', kind: 'rss', publisher_type: 'preprint', quality_tier: 2, default_category: 'psychology',
    url: 'https://share.osf.io/api/v2/feeds/rss/?elasticQuery=%7B%22bool%22%3A%7B%22must%22%3A%7B%22query_string%22%3A%7B%22query%22%3A%22*%22%7D%7D%7D%7D', homepage: 'https://osf.io/preprints/psyarxiv' },

  // Peer-reviewed journals
  { name: 'Nature', kind: 'rss', publisher_type: 'journal', quality_tier: 1, url: 'https://www.nature.com/nature.rss', homepage: 'https://www.nature.com' },
  { name: 'Nature Neuroscience', kind: 'rss', publisher_type: 'journal', quality_tier: 1, default_category: 'neuroscience',
    url: 'https://www.nature.com/neuro.rss', homepage: 'https://www.nature.com/neuro/' },
  { name: 'Science · News', kind: 'rss', publisher_type: 'journal', quality_tier: 1, url: 'https://www.science.org/rss/news_current.xml', homepage: 'https://www.science.org' },
  { name: 'eLife', kind: 'rss', publisher_type: 'journal', quality_tier: 1, url: 'https://elifesciences.org/rss/recent.xml', homepage: 'https://elifesciences.org' },
  { name: 'PLOS Biology', kind: 'rss', publisher_type: 'journal', quality_tier: 1, default_category: 'biology',
    url: 'https://journals.plos.org/plosbiology/feed/atom', homepage: 'https://journals.plos.org/plosbiology/' },
  { name: 'PLOS Computational Biology', kind: 'rss', publisher_type: 'journal', quality_tier: 1, default_category: 'systems',
    url: 'https://journals.plos.org/ploscompbiol/feed/atom', homepage: 'https://journals.plos.org/ploscompbiol/' },
  { name: 'Royal Society Interface', kind: 'rss', publisher_type: 'journal', quality_tier: 1, default_category: 'systems',
    url: 'https://royalsocietypublishing.org/rss/rsif/latest', homepage: 'https://royalsocietypublishing.org/journal/rsif' },

  // Bibliographic APIs — broad sweeps, filtered by the profile
  { name: 'Crossref · recent journal articles', kind: 'crossref', publisher_type: 'journal', quality_tier: 1,
    url: 'https://api.crossref.org/works?filter=type:journal-article,has-abstract:true&sort=published&order=desc&rows=60',
    homepage: 'https://www.crossref.org', notes: 'Broad sweep. Narrow with &query.bibliographic= if it is too noisy.' },
  { name: 'PubMed · regulation and homeostasis', kind: 'pubmed', publisher_type: 'journal', quality_tier: 1, default_category: 'medicine',
    url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=homeostasis+OR+allostasis+OR+interoception&retmax=30&sort=date&retmode=json',
    homepage: 'https://pubmed.ncbi.nlm.nih.gov' },

  // Institutions and serious magazines
  { name: 'Quanta Magazine', kind: 'rss', publisher_type: 'magazine', quality_tier: 2, url: 'https://www.quantamagazine.org/feed/', homepage: 'https://www.quantamagazine.org' },
  { name: 'Aeon', kind: 'rss', publisher_type: 'magazine', quality_tier: 2, default_category: 'philosophy', url: 'https://aeon.co/feed.rss', homepage: 'https://aeon.co' },
  { name: 'Nautilus', kind: 'rss', publisher_type: 'magazine', quality_tier: 2, url: 'https://nautil.us/feed/', homepage: 'https://nautil.us' },
  { name: 'MIT News · Research', kind: 'rss', publisher_type: 'institution', quality_tier: 2, url: 'https://news.mit.edu/rss/research', homepage: 'https://news.mit.edu' },
  { name: 'Max Planck Society · Research news', kind: 'rss', publisher_type: 'institution', quality_tier: 2, url: 'https://www.mpg.de/rss/all-news', homepage: 'https://www.mpg.de' }
];

function seedSources() {
  const stmt = db.prepare(`INSERT OR IGNORE INTO sources
    (name, kind, url, homepage, publisher_type, quality_tier, default_category, notes)
    VALUES (@name, @kind, @url, @homepage, @publisher_type, @quality_tier, @default_category, @notes)`);
  let n = 0;
  for (const s of SOURCES) {
    const r = stmt.run({
      homepage: null, default_category: null,
      notes: 'Seeded starter source — press “test” in the editorial desk to confirm the URL still resolves.',
      ...s
    });
    n += r.changes;
  }
  console.log(`sources: ${n} added, ${SOURCES.length - n} already present`);
}

// ---------------------------------------------------------------------------
// PROFILE
// ---------------------------------------------------------------------------
// A STARTING POINT, not a hard-coded identity. Everything below is editable at
// /profile, and editing it re-assesses the whole library.
const STATEMENT = `I work on biological regulation: how control loops in living systems terminate rather than run forever, what makes a regulatory process close, and how safety is signalled and validated inside a distributed body. Around that sit questions about perception and inference, about how control is distributed across a system with no central controller, and about what makes a complex adaptive system hold together. I am interested in theory that crosses disciplines — the same problem stated in another field's vocabulary is usually the useful find.`;

const INTERESTS = [
  ['topic', 'biological regulation', 1.2],
  ['topic', 'closure', 1.1],
  ['topic', 'safety', 1],
  ['topic', 'distributed control', 1.1],
  ['topic', 'perception', 1],
  ['topic', 'cognition', 1],
  ['topic', 'complex adaptive systems', 1.1],
  ['concept', 'homeostasis', 1],
  ['concept', 'allostasis', 1],
  ['concept', 'feedback', 0.9],
  ['concept', 'predictive processing', 1.1],
  ['concept', 'interoception', 1],
  ['concept', 'termination', 0.9],
  ['concept', 'self-organisation', 1],
  ['concept', 'emergence', 0.8],
  ['concept', 'regulation', 1],
  ['field', 'neuroscience', 0.8],
  ['field', 'systems biology', 0.8],
  ['field', 'cybernetics', 0.9],
  ['field', 'control theory', 0.9],
  ['field', 'complexity science', 0.8]
];

// The periphery map: where else these concepts live under other names.
const ADJACENCY = [
  ['biological regulation', 'governance', 'organisational theory', 0.6],
  ['biological regulation', 'ecosystem regulation', 'ecology', 0.7],
  ['biological regulation', 'feedback control', 'control theory', 0.8],
  ['closure', 'termination condition', 'computer science', 0.8],
  ['closure', 'fixed point', 'mathematics', 0.7],
  ['closure', 'operational closure', 'philosophy', 0.8],
  ['closure', 'halting', 'computer science', 0.7],
  ['safety', 'fault tolerance', 'distributed systems', 0.8],
  ['safety', 'graceful degradation', 'engineering', 0.7],
  ['safety', 'resilience', 'ecology', 0.7],
  ['safety', 'risk homeostasis', 'behavioural science', 0.6],
  ['distributed control', 'consensus protocol', 'computer science', 0.8],
  ['distributed control', 'stigmergy', 'ethology', 0.8],
  ['distributed control', 'swarm', 'network science', 0.7],
  ['distributed control', 'polycentric', 'political economy', 0.7],
  ['perception', 'signal detection', 'information theory', 0.7],
  ['perception', 'sensing', 'engineering', 0.5],
  ['perception', 'active inference', 'cognitive science', 0.9],
  ['cognition', 'distributed cognition', 'anthropology', 0.8],
  ['cognition', 'collective intelligence', 'sociology', 0.7],
  ['complex adaptive systems', 'criticality', 'physics', 0.7],
  ['complex adaptive systems', 'network topology', 'network science', 0.7],
  ['complex adaptive systems', 'evolvability', 'evolutionary biology', 0.7],
  ['complex adaptive systems', 'institutional design', 'organisational theory', 0.6],
  ['homeostasis', 'set point', 'control theory', 0.7],
  ['homeostasis', 'carrying capacity', 'ecology', 0.6],
  ['predictive processing', 'error correction', 'information theory', 0.7],
  ['regulation', 'requisite variety', 'cybernetics', 0.9],
  ['regulation', 'compliance', 'sociology', 0.4],
  ['emergence', 'phase transition', 'physics', 0.7],
  ['self-organisation', 'autocatalysis', 'chemistry', 0.7]
];

function seedProfile() {
  const p = db.prepare('SELECT statement FROM research_profile WHERE id = 1').get();
  if (!p?.statement) {
    db.prepare(`UPDATE research_profile SET statement = ?, updated_at = datetime('now') WHERE id = 1`).run(STATEMENT);
    console.log('profile: research statement seeded (edit it at /profile)');
  } else {
    console.log('profile: statement already written, left alone');
  }

  const exists = db.prepare('SELECT 1 FROM research_interests WHERE kind = ? AND value = ?');
  const add = db.prepare('INSERT INTO research_interests (kind, value, weight) VALUES (?, ?, ?)');
  let n = 0;
  for (const [kind, value, weight] of INTERESTS) {
    if (!exists.get(kind, value)) { add.run(kind, value, weight); n++; }
  }
  console.log(`interests: ${n} added`);

  const addAdj = db.prepare(`INSERT OR IGNORE INTO concept_adjacency (concept, adjacent, field, strength)
                             VALUES (?, ?, ?, ?)`);
  let m = 0;
  for (const [c, a, f, s] of ADJACENCY) m += addAdj.run(c, a, f, s).changes;
  console.log(`periphery map: ${m} bridges added`);
}

// ---------------------------------------------------------------------------
// DEMO CONTENT
// ---------------------------------------------------------------------------
// Every item below is flagged is_demo = 1 and carries the demo banner, the demo
// badge, and a source that says plainly it is not a real publication. There are
// no invented authors, journals, DOIs or URLs anywhere in it: inventing a
// plausible citation would be worse than having none. These exist so the
// furniture can be looked at before the pipeline has run, and
// `npm run seed:clear` removes them.
const DEMO_SOURCE = 'Demo entry — not a real publication';

const DEMO = [
  {
    title: 'How a control loop knows when to stop',
    dek: 'A worked example of the shape of an entry, using a question about termination in regulatory systems',
    category: 'regulation',
    publication_type: 'paper', peer_review: 'peer_reviewed',
    reading: 24, long: false, periphery: false, status: 'core',
    short: 'An illustrative entry showing how PERIPHERY presents a piece of primary research: what was done, what was found, and how far the evidence reaches.',
    summary: `This is demonstration content. It stands in for a paper about the conditions under which a physiological control loop terminates rather than continuing to correct, and it exists to show what an entry looks like when the pipeline has filled one in.\n\nIn a real entry, this section would be two to four paragraphs summarising the actual work, written from the abstract and metadata that were retrieved from the source. It would name the system studied, the measurement, and the size of the effect where the source gives one.`,
    what_happened: 'A demonstration item, standing in for a study of when regulatory correction stops.',
    what_they_did: 'In a real entry this states the method as specifically as the source allows — the preparation, the measurement, the number of subjects or runs, the comparison.',
    what_they_found: 'In a real entry this states the result as a finding, separately from what the authors take it to mean.',
    evidence: 'This is demonstration content and carries no evidence at all. In a real entry this paragraph names the design and its limits — sample size, single site, model organism, correlational structure, preprint status — and says how much weight the claim can bear.',
    why_interesting: 'The interesting thing about termination is that it is rarely measured directly. Most regulatory models specify how a system corrects and leave open what makes correction stop.',
    broader: 'What distinguishes a process that closes from one that merely quiets down, and does the distinction hold across biological, mechanical and social regulation?',
    matters: 'Where a loop stops determines what counts as regulated. In a real entry this paragraph would say what turns on the finding.',
    connection: 'Sits on the closure and biological-regulation terms in the profile.',
    concepts: ['closure', 'feedback', 'homeostasis', 'termination']
  },
  {
    title: 'Consensus protocols and the problem of knowing you are finished',
    dek: 'A periphery example: distributed computing arriving at the same question from another direction',
    category: 'distributed',
    publication_type: 'paper', peer_review: 'peer_reviewed',
    reading: 31, long: false, periphery: true, bridge: 'computer science → closure', status: 'periphery',
    short: 'Demonstration of a periphery pick: no overlap with the profile vocabulary, but a neighbouring field working on the same underlying problem.',
    summary: `Demonstration content. It stands in for work in distributed systems on termination detection — how a set of processes with no central coordinator establishes that the computation is over.\n\nThe point of including it is structural rather than factual: it shows how the system presents something the reader would not have found by searching their own terms, and how it explains the bridge that brought it in.`,
    what_happened: 'A demonstration item, standing in for work on termination detection in distributed computation.',
    what_they_did: 'A real entry would describe the protocol, the failure model it assumes, and what was proved or measured.',
    what_they_found: 'A real entry would state the result and the conditions under which it holds.',
    evidence: 'Demonstration content, no evidence. In a real entry, theoretical results would be distinguished from simulation results and from deployment experience.',
    why_interesting: 'Termination detection is closure with the biology taken out. The formal treatment is much sharper than the physiological one, and the constraints it identifies may transfer.',
    broader: 'Does a general theory of closure exist, or does each substrate need its own?',
    connection: 'No direct keyword overlap. Surfaced because "termination condition" in computer science bridges to closure in the profile.',
    concepts: ['closure', 'distributed systems', 'termination', 'coordination']
  },
  {
    title: 'Interoceptive signals and the timing of physiological correction',
    dek: 'A preprint example, showing how unreviewed material is labelled',
    category: 'neuroscience',
    publication_type: 'preprint', peer_review: 'preprint',
    reading: 19, long: false, periphery: false, status: 'core',
    short: 'Demonstration of how a preprint appears: flagged everywhere it is shown, with the provisional status stated in the evidence assessment.',
    summary: `Demonstration content standing in for a preprint on interoceptive signalling and the timing of regulatory correction.\n\nWhat matters here is the labelling. A preprint carries its status on the front page, in the edition, on the article page and in the provenance block, because the difference between reviewed and unreviewed work is the first thing a reader needs.`,
    what_happened: 'A demonstration item, standing in for an unreviewed preprint.',
    what_they_did: 'A real entry would give the method in the detail the abstract allows.',
    what_they_found: 'A real entry would state the reported result, marked as reported rather than established.',
    evidence: 'This is a preprint and has not been through peer review, so the claims are provisional. In a real entry this paragraph would also name the sample, the design, and whether the analysis was preregistered.',
    why_interesting: 'Timing is the part of interoception hardest to measure and the part most theories depend on.',
    broader: 'How much of regulation is explained by when a signal arrives rather than what it says?',
    connection: 'Direct overlap with interoception and predictive processing.',
    concepts: ['interoception', 'predictive processing', 'timing', 'regulation']
  },
  {
    title: 'Requisite variety, revisited',
    dek: 'Demonstration of a theory entry, where the useful part is a distinction rather than a result',
    category: 'systems',
    publication_type: 'review', peer_review: 'peer_reviewed',
    reading: 42, long: false, periphery: false, status: 'adjacent',
    short: 'Demonstration of how theoretical work is summarised when there is no experiment to report.',
    summary: `Demonstration content standing in for a review of Ashby's law of requisite variety and its later reformulations.\n\nTheoretical entries are summarised differently: the "what they found" line becomes the distinction or argument the piece establishes, and the evidence assessment says what kind of support a conceptual claim has.`,
    what_happened: 'A demonstration item, standing in for a theoretical review.',
    what_they_did: 'A real entry would describe the scope of the review and the literature it covers.',
    what_they_found: 'A real entry would state the argument, marked as an argument.',
    evidence: 'Conceptual work is not evidence in the empirical sense. In a real entry this paragraph would say which claims are supported by cited studies and which are analytic.',
    why_interesting: 'Requisite variety is one of the few genuinely cross-disciplinary results in this area, and it is cited far more often than it is used.',
    broader: 'What does a controller need to know about what it controls?',
    connection: 'Overlaps with cybernetics and regulation.',
    concepts: ['cybernetics', 'requisite variety', 'control', 'regulation']
  },
  {
    title: 'Stigmergy in the absence of a plan',
    dek: 'Another periphery example, this time from ethology',
    category: 'behaviour',
    publication_type: 'paper', peer_review: 'peer_reviewed',
    reading: 26, long: false, periphery: true, bridge: 'ethology → distributed control', status: 'periphery',
    short: 'Demonstration of a second periphery pick, showing how the rail on the front page groups adjacent finds.',
    summary: `Demonstration content standing in for work on stigmergic coordination — organisms coordinating through modifications to a shared environment rather than through direct signalling.\n\nIt appears here to show the periphery rail with more than one item in it, and to show how the bridge is displayed alongside the entry.`,
    what_happened: 'A demonstration item, standing in for work on environment-mediated coordination.',
    what_they_did: 'A real entry would state the species, the setting and the manipulation.',
    what_they_found: 'A real entry would state the observed behaviour and its statistical support.',
    evidence: 'Demonstration content, no evidence.',
    why_interesting: 'Coordination without communication is the cleanest case of control with no controller.',
    broader: 'How much regulatory structure can be offloaded onto the environment?',
    connection: 'No direct overlap. Reached through stigmergy as a neighbouring treatment of distributed control.',
    concepts: ['stigmergy', 'coordination', 'distributed systems', 'behaviour']
  },
  {
    title: 'What ecologists mean by resilience, and what they do not',
    dek: 'Demonstration of a definitional piece from an adjacent field',
    category: 'ecology',
    publication_type: 'essay', peer_review: 'not_applicable',
    reading: 17, long: false, periphery: true, bridge: 'ecology → safety', status: 'periphery',
    short: 'Demonstration of an essay entry — no method, no result, and the evidence block says so.',
    summary: `Demonstration content standing in for an essay on the several incompatible things "resilience" means in ecology.\n\nEssays are summarised without pretending to be studies: there is no finding, and the entry says as much rather than manufacturing one.`,
    what_happened: 'A demonstration item, standing in for an essay.',
    what_they_did: null,
    what_they_found: null,
    evidence: 'This is an essay, not a study. There is no design to assess. In a real entry this line would say the same, and point to the sources the essay itself relies on.',
    why_interesting: 'Terms that travel between disciplines usually lose their conditions of application on the way.',
    broader: 'When a concept crosses fields, what has to travel with it for the transfer to be legitimate?',
    connection: 'Reached through resilience as an ecological treatment of safety.',
    concepts: ['resilience', 'ecology', 'safety', 'definitions']
  },
  {
    title: 'Measuring criticality in systems that will not sit still',
    dek: 'A methods entry, demonstrating how measurement problems are presented',
    category: 'systems',
    publication_type: 'paper', peer_review: 'peer_reviewed',
    reading: 35, long: false, periphery: false, status: 'adjacent',
    short: 'Demonstration of a methods-focused entry, where the interesting part is what the measurement cannot show.',
    summary: `Demonstration content standing in for methodological work on detecting critical dynamics in non-stationary systems.\n\nMethods entries lead with the limitation rather than the claim, because that is the part a reader needs before citing anything downstream of it.`,
    what_happened: 'A demonstration item, standing in for a methods paper.',
    what_they_did: 'A real entry would state the estimator, the data, and the validation.',
    what_they_found: 'A real entry would state where the method works and where it fails.',
    evidence: 'Demonstration content, no evidence.',
    why_interesting: 'Criticality claims are common and the measurement assumptions behind them are often not stated.',
    broader: 'How much of the evidence for critical dynamics survives a non-stationary world?',
    connection: 'Touches complex adaptive systems and criticality.',
    concepts: ['criticality', 'methods', 'complex systems', 'measurement']
  },
  {
    title: 'A note on what this demo set is not',
    dek: 'The one entry that is only about itself',
    category: 'general',
    publication_type: 'article', peer_review: 'not_applicable',
    reading: 3, long: false, periphery: false, status: 'background',
    short: 'These entries are furniture. They exist so the layout can be judged before real material arrives, and they carry no external links because none would be honest.',
    summary: `Everything in this demo set is labelled demo content, in the badge on the card, in the banner on the article page, and in the source line that reads "Demo entry — not a real publication".\n\nNo authors, journals, DOIs or URLs have been invented anywhere in it. A plausible-looking citation that leads nowhere is worse than an obvious placeholder, so the demo entries carry no external source at all — every "source" link lands on a page explaining this.\n\nRemove the whole set with npm run seed:clear. Once the pipeline has run, real material outranks demo material in every edition.`,
    what_happened: null, what_they_did: null, what_they_found: null,
    evidence: 'Not applicable — this is a notice, not a report of anything.',
    why_interesting: null,
    broader: null,
    matters: 'Because a research tool that quietly fabricates sources is worse than no research tool.',
    connection: null,
    concepts: ['demo']
  },

  // ---- long form ----
  {
    title: 'Regulation without a regulator: a long-form demonstration',
    dek: 'How The Long Read presents a substantial piece — approach first, original second',
    category: 'regulation',
    publication_type: 'review', peer_review: 'peer_reviewed',
    reading: 78, long: true, periphery: false, status: 'core',
    short: 'A demonstration long read, showing the selection rationale, the territory note, and the concepts a piece puts in play.',
    summary: `Demonstration content standing in for a long review of decentralised regulation across biological scales.\n\nIn The Long Read the summary is deliberately short. The original is the reading experience; these paragraphs are the approach to it.`,
    evidence: 'Demonstration content, no evidence to assess.',
    rationale: 'Chosen for the Wednesday selection because it sits directly on the profile: distributed control and biological regulation, at review length rather than paper length.',
    territory: 'Physiology, control theory and systems biology, held together by the question of what a regulator has to be.',
    raised: 'Whether "regulator" is a role or a structure; what a control loop needs to know about itself; whether decentralised regulation is a distinct kind or a limiting case.',
    connection: 'Direct overlap with distributed control and biological regulation.',
    concepts: ['regulation', 'distributed control', 'physiology', 'control theory']
  },
  {
    title: 'The vocabulary problem: one idea, eleven disciplines',
    dek: 'A weekend-selection demonstration, ranging further from the profile',
    category: 'philosophy',
    publication_type: 'essay', peer_review: 'not_applicable',
    reading: 46, long: true, periphery: true, bridge: 'philosophy of science → closure', status: 'periphery',
    short: 'Demonstration of a weekend long read: chosen for range rather than fit.',
    summary: `Demonstration content standing in for a long essay on concepts that recur across disciplines under different names, and what is lost each time one is translated.\n\nWeekend selections are looser by design. This one would have been excluded by a keyword filter and included by a bridge.`,
    evidence: 'An essay. No design to assess.',
    rationale: 'Chosen for the weekend because it is outside the stated profile but underneath the same problem — the reason the periphery principle exists at all.',
    territory: 'Philosophy of science, conceptual history, and the sociology of disciplines.',
    raised: 'What survives translation between fields; whether convergent vocabulary indicates a real kind; how to tell a genuine cross-disciplinary result from a pun.',
    connection: 'Reached through the closure bridge into philosophy of science.',
    concepts: ['philosophy of science', 'concepts', 'interdisciplinarity', 'closure']
  },
  {
    title: 'Reading a preprint properly: a demonstration',
    dek: 'What to check before citing unreviewed work',
    category: 'philosophy',
    publication_type: 'preprint', peer_review: 'preprint',
    reading: 55, long: true, periphery: false, status: 'adjacent',
    short: 'Demonstration long read carrying preprint status, to show the labelling at long-form length.',
    summary: `Demonstration content standing in for a methodological piece on evaluating preprints.\n\nIt is itself marked as a preprint, which is the point: the label appears on the card, in the edition, and in the provenance block, at every length.`,
    evidence: 'Demonstration content. As a preprint it would carry no review; a real entry would say what has and has not been checked.',
    rationale: 'Included to show a long-form preprint, where the review-status labelling matters most.',
    territory: 'Research methods, scientific publishing, evidence assessment.',
    raised: 'What peer review actually filters; how to weigh an unreviewed result; when a preprint is the better source.',
    connection: 'Adjacent — bears on how everything else in the collection should be read.',
    concepts: ['preprints', 'peer review', 'methods', 'evidence']
  }
];

function seedDemo() {
  const already = db.prepare('SELECT count(*) n FROM articles WHERE is_demo = 1').get().n;
  if (already) { console.log(`demo: ${already} demo items already present — run "clear-demo" first to reseed`); return; }

  const insert = db.prepare(`INSERT INTO articles (
      slug, title, dek, short_summary, research_summary, what_happened, what_they_did,
      what_they_found, evidence_strength, why_interesting, broader_question, why_it_matters,
      connection_to_research, selection_rationale, intellectual_territory, concepts_raised,
      source_name, source_url, authors, publication_date, publication_type, peer_review_status,
      category, reading_time_min, word_estimate, relevance_status, relevance_score,
      relevance_rationale, is_periphery_pick, periphery_bridge, status, is_long_form, is_demo,
      summary_provenance, content_hash, published_at)
    VALUES (@slug, @title, @dek, @short_summary, @research_summary, @what_happened, @what_they_did,
      @what_they_found, @evidence_strength, @why_interesting, @broader_question, @why_it_matters,
      @connection_to_research, @selection_rationale, @intellectual_territory, @concepts_raised,
      @source_name, @source_url, NULL, @publication_date, @publication_type, @peer_review_status,
      @category, @reading_time_min, @word_estimate, @relevance_status, @relevance_score,
      @relevance_rationale, @is_periphery_pick, @periphery_bridge, 'published', @is_long_form, 1,
      'human', @content_hash, datetime('now'))
    RETURNING id`);

  const getTag = db.prepare('SELECT id FROM tags WHERE slug = ?');
  const addTag = db.prepare('INSERT INTO tags (name, slug, kind) VALUES (?, ?, ?) RETURNING id');
  const linkTag = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)');

  const today = new Date().toISOString().slice(0, 10);
  const ids = { daily: [], long: [] };

  for (const d of DEMO) {
    const row = insert.get({
      slug: 'demo-' + slugify(d.title),
      title: d.title,
      dek: d.dek,
      short_summary: d.short,
      research_summary: d.summary,
      what_happened: d.what_happened ?? null,
      what_they_did: d.what_they_did ?? null,
      what_they_found: d.what_they_found ?? null,
      evidence_strength: d.evidence ?? null,
      why_interesting: d.why_interesting ?? null,
      broader_question: d.broader ?? null,
      why_it_matters: d.matters ?? null,
      connection_to_research: d.connection ?? null,
      selection_rationale: d.rationale ?? null,
      intellectual_territory: d.territory ?? null,
      concepts_raised: d.raised ?? null,
      source_name: DEMO_SOURCE,
      source_url: '/demo-source',
      publication_date: today,
      publication_type: d.publication_type,
      peer_review_status: d.peer_review,
      category: d.category,
      reading_time_min: d.reading,
      word_estimate: d.reading * 200,
      relevance_status: d.status,
      relevance_score: d.periphery ? 2.1 : (d.status === 'core' ? 5.4 : 2.8),
      relevance_rationale: d.connection ?? 'Demonstration item.',
      is_periphery_pick: d.periphery ? 1 : 0,
      periphery_bridge: d.bridge ?? null,
      is_long_form: d.long ? 1 : 0,
      content_hash: hash('demo', d.title)
    });
    for (const name of d.concepts || []) {
      const slug = slugify(name);
      const tag = getTag.get(slug) || addTag.get(name, slug, 'concept');
      linkTag.run(row.id, tag.id);
    }
    ids[d.long ? 'long' : 'daily'].push(row.id);
  }

  const mkEdition = db.prepare(`INSERT INTO editions (kind, edition_date, title, standfirst, editors_note,
      status, item_count, generated_by, published_at)
    VALUES (?, ?, ?, ?, ?, 'published', ?, 'demo seed', datetime('now'))
    ON CONFLICT(kind, edition_date) DO UPDATE SET item_count = excluded.item_count RETURNING id`);
  const addItem = db.prepare('INSERT OR REPLACE INTO edition_items (edition_id, article_id, position, slot) VALUES (?, ?, ?, ?)');

  const daily = mkEdition.get('daily', today, 'The Daily Observatory',
    `${ids.daily.length} demonstration entries, two of them found through the periphery map rather than by direct match.`,
    'This edition is the labelled demo set, loaded so the interface can be judged before the pipeline has run. Every entry is marked as demo content and none of them links to an external source, because none of them reports a real study. Run an ingestion and build a real edition to replace it.',
    ids.daily.length);
  ids.daily.forEach((id, i) => addItem.run(daily.id, id, i, i === 0 ? 'lead' : 'main'));

  const long = mkEdition.get('long_read', today, 'The Long Read',
    `${ids.long.length} demonstration selections, showing the Wednesday and weekend shapes.`,
    'Demonstration content. In a real edition the summaries stay short and the original piece remains the reading; that structure is what these entries are here to show.',
    ids.long.length);
  ids.long.forEach((id, i) => addItem.run(long.id, id, i, 'main'));

  console.log(`demo: ${DEMO.length} labelled demo entries, in a demo daily edition and a demo long read for ${today}`);
}

function clearDemo() {
  const n = db.prepare('SELECT count(*) n FROM articles WHERE is_demo = 1').get().n;
  db.prepare(`DELETE FROM edition_items WHERE article_id IN (SELECT id FROM articles WHERE is_demo = 1)`).run();
  db.prepare('DELETE FROM articles WHERE is_demo = 1').run();
  db.prepare(`DELETE FROM editions WHERE generated_by = 'demo seed'
              AND NOT EXISTS (SELECT 1 FROM edition_items ei WHERE ei.edition_id = editions.id)`).run();
  db.prepare(`DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM article_tags at WHERE at.tag_id = tags.id)`).run();
  console.log(`removed ${n} demo items and any edition left empty by it`);
}

const cmd = process.argv[2] || 'all';
if (cmd === 'sources') seedSources();
else if (cmd === 'profile') seedProfile();
else if (cmd === 'demo') seedDemo();
else if (cmd === 'clear-demo') clearDemo();
else if (cmd === 'all') { seedSources(); seedProfile(); seedDemo(); }
else { console.error('Usage: seed.js [sources|profile|demo|all|clear-demo]'); process.exit(1); }
