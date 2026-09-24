// Minimal .env parser/serializer that keeps comments, blank lines and untouched lines as they were.

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;

function unquote(v) {
  const t = v.trim();
  if (t.startsWith("'")) {
    const end = t.indexOf("'", 1);
    return end > 0 ? t.slice(1, end) : t.slice(1);
  }
  if (t.startsWith('"')) {
    let out = '';
    for (let i = 1; i < t.length; i++) {
      const c = t[i];
      if (c === '\\' && i + 1 < t.length) {
        const n = t[++i];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else if (c === '"') break;
      else out += c;
    }
    return out;
  }
  const hash = t.search(/\s#/);
  return (hash >= 0 ? t.slice(0, hash) : t).trim();
}

/** -> [{ id, key, value, raw }] where key === null marks a comment/blank/unparsed line. */
export function parseEnv(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map((raw, id) => {
    const m = raw.match(LINE_RE);
    if (!m || raw.trim().startsWith('#')) return { id, key: null, value: '', raw };
    const value = unquote(m[2]);
    return { id, key: m[1], value, raw, orig: { key: m[1], value } };
  });
}

function quote(v) {
  if (v === '' || /^[A-Za-z0-9_./:@%+,=-]+$/.test(v)) return v;
  if (!v.includes("'") && !v.includes('\n')) return `'${v}'`;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function serializeEnv(lines) {
  const out = [];
  for (const l of lines) {
    if (l.deleted) continue;
    if (l.key === null) out.push(l.raw);
    else if (!l.key.trim()) continue;
    else if (l.orig && l.orig.key === l.key && l.orig.value === l.value) out.push(l.raw);
    else out.push(`${l.key.trim()}=${quote(l.value)}`);
  }
  return out.join('\n') + '\n';
}

export const isSecretKey = (k) => /pass|secret|token|key|private|credential/i.test(k || '');
