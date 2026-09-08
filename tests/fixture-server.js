/**
 * A local stand-in for the outside world.
 *
 * Serves an RSS 2.0 feed, an Atom feed and an arXiv-shaped Atom response so the
 * retrieval, deduplication, classification, relevance and edition-generation
 * stages can be exercised end to end without depending on anyone's servers.
 *
 * The entries are obvious test fixtures. They are not passed off as real work
 * anywhere, and they never reach the seeded database.
 */
import http from 'node:http';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Fixture Journal of Regulation</title>
  <link>http://localhost:4100/journal</link>
  <item>
    <title>TEST FIXTURE: negative feedback and the termination of a homeostatic correction</title>
    <link>http://localhost:4100/journal/1</link>
    <guid>http://localhost:4100/journal/1</guid>
    <dc:creator>Fixture Author One, Fixture Author Two</dc:creator>
    <pubDate>Mon, 01 Sep 2026 09:00:00 GMT</pubDate>
    <description>A test fixture. We measured how a homeostatic control loop stops correcting once a set point is restored. Participants (n = 48) completed a within-subject protocol and we found that termination timing tracked interoceptive signal latency rather than error magnitude.</description>
  </item>
  <item>
    <title>TEST FIXTURE: consensus protocols and termination detection in a partially synchronous network</title>
    <link>http://localhost:4100/journal/2</link>
    <guid>http://localhost:4100/journal/2</guid>
    <dc:creator>Fixture Author Three</dc:creator>
    <pubDate>Tue, 02 Sep 2026 09:00:00 GMT</pubDate>
    <description>A test fixture from computer science. We prove a termination condition for a distributed consensus protocol under a crash-failure model, and evaluate fault tolerance in simulation. No biological claim is made.</description>
  </item>
  <item>
    <title>TEST FIXTURE: an unrelated item about eighteenth-century ceramics</title>
    <link>http://localhost:4100/journal/3</link>
    <guid>http://localhost:4100/journal/3</guid>
    <pubDate>Wed, 03 Sep 2026 09:00:00 GMT</pubDate>
    <description>A test fixture with no overlap with the research profile at all, present to confirm that irrelevant material is scored as background and kept out of editions.</description>
  </item>
  <item>
    <title>TEST FIXTURE: negative feedback and the termination of a homeostatic correction</title>
    <link>http://localhost:4100/journal/1-duplicate</link>
    <guid>http://localhost:4100/journal/1-duplicate</guid>
    <pubDate>Wed, 03 Sep 2026 10:00:00 GMT</pubDate>
    <description>A deliberate duplicate of the first item, to confirm deduplication.</description>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Fixture Review of Ecology</title>
  <entry>
    <id>http://localhost:4100/atom/1</id>
    <title>TEST FIXTURE: resilience and carrying capacity in a modelled ecosystem</title>
    <link rel="alternate" href="http://localhost:4100/atom/1"/>
    <author><name>Fixture Author Four</name></author>
    <published>2026-09-02T00:00:00Z</published>
    <summary>A test fixture from ecology. We model ecosystem resilience under repeated disturbance and report where the system loses its capacity to return. Uses no vocabulary from the reader's own profile, which is the point of the fixture.</summary>
  </entry>
  <entry>
    <id>http://localhost:4100/atom/2</id>
    <title>TEST FIXTURE: a long essay on requisite variety and what controllers must know</title>
    <link rel="alternate" href="http://localhost:4100/atom/2"/>
    <author><name>Fixture Author Five</name></author>
    <published>2026-09-04T00:00:00Z</published>
    <content>A test fixture essay on cybernetics and requisite variety, long enough to be treated as long-form. ${'Filler sentence for word counting. '.repeat(120)}</content>
  </entry>
</feed>`;

const ARXIV = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://localhost:4100/abs/2609.00001v1</id>
    <title>TEST FIXTURE: distributed control without a central controller in a swarm model</title>
    <summary>A test fixture preprint. We simulate stigmergic coordination in a swarm and characterise the conditions for stable distributed control. Preprint; not peer reviewed.</summary>
    <published>2026-09-05T00:00:00Z</published>
    <author><name>Fixture Author Six</name></author>
    <link href="http://localhost:4100/abs/2609.00001v1" type="text/html"/>
    <link title="pdf" href="http://localhost:4100/pdf/2609.00001v1"/>
    <arxiv:primary_category term="nlin.AO"/>
  </entry>
</feed>`;

export function startFixtureServer(port = 4100) {
  const server = http.createServer((req, res) => {
    const body = req.url.startsWith('/rss') ? RSS
      : req.url.startsWith('/atom') ? ATOM
      : req.url.startsWith('/arxiv') ? ARXIV
      : null;
    if (!body) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
    res.end(body);
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

if (process.argv[1]?.endsWith('fixture-server.js')) {
  startFixtureServer().then(() => console.log('fixture feeds on http://localhost:4100/{rss,atom,arxiv}'));
}
