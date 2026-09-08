const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parse(d) {
  if (!d) return null;
  const s = String(d).includes('T') || String(d).includes(' ') ? String(d).replace(' ', 'T') : `${d}T00:00:00`;
  const date = new Date(s.endsWith('Z') ? s : `${s}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const fmt = {
  /** Sunday, 7 September 2026 */
  long(d) {
    const x = parse(d);
    if (!x) return '';
    return `${DAYS[x.getUTCDay()]}, ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
  },
  /** 7 September 2026 */
  date(d) {
    const x = parse(d);
    if (!x) return '';
    return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
  },
  /** 7 Sep 2026 */
  short(d) {
    const x = parse(d);
    if (!x) return '';
    return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()].slice(0, 3)} ${x.getUTCFullYear()}`;
  },
  time(d) {
    const x = parse(d);
    return x ? x.toISOString().slice(11, 16) : '';
  },
  ago(d) {
    const x = parse(d);
    if (!x) return '';
    const mins = Math.round((Date.now() - x.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    if (h < 24) return `${h} h ago`;
    const days = Math.round(h / 24);
    return days < 30 ? `${days} d ago` : fmt.short(d);
  },
  /** Split stored prose into paragraphs for rendering. */
  paras(text) {
    if (!text) return [];
    return String(text).split(/\n{2,}|\r\n\r\n/).map(s => s.trim()).filter(Boolean);
  },
  authors(s, max = 3) {
    if (!s) return '';
    const list = String(s).split(/,\s*/).filter(Boolean);
    if (list.length <= max) return list.join(', ');
    return `${list.slice(0, max).join(', ')} and ${list.length - max} others`;
  },
  host(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  },
  minutes(n) {
    if (!n) return '';
    if (n < 60) return `${n} min`;
    const h = Math.floor(n / 60), m = n % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
};

export default fmt;
