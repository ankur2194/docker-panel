import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, enc, stream } from '../api.js';
import { isSecretKey, parseEnv, serializeEnv } from '../env.js';
import { Icon } from '../icons.jsx';
import { ErrorBanner, IconButton, useApp } from '../ui.jsx';

const uniq = (a) => [...new Set(a)];
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/* ---------------- Configuration ---------------- */

function FileSelector({ idPrefix, available, selected, onChange }) {
  const items = uniq([...selected, ...available]);
  const move = (f, d) => {
    const i = selected.indexOf(f);
    const j = i + d;
    if (j < 0 || j >= selected.length) return;
    const next = [...selected];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const toggle = (f, on) => onChange(on ? [...selected, f] : selected.filter((x) => x !== f));
  return (
    <div class="list">
      {!items.length && <div class="empty muted small">No files found in the project directory.</div>}
      {items.map((f, idx) => {
        const i = selected.indexOf(f);
        return (
          <div class="list-row" key={f}>
            <input type="checkbox" id={`${idPrefix}-${idx}`} checked={i >= 0} onChange={(e) => toggle(f, e.currentTarget.checked)} />
            <label for={`${idPrefix}-${idx}`} class={`grow mono small ${i >= 0 ? '' : 'muted'}`}>{f}</label>
            {i >= 0 && <span class="order">{i + 1}</span>}
            <IconButton icon="up" label={`Move ${f} up`} disabled={i <= 0} onClick={() => move(f, -1)} />
            <IconButton icon="down" label={`Move ${f} down`} disabled={i < 0 || i === selected.length - 1} onClick={() => move(f, 1)} />
          </div>
        );
      })}
    </div>
  );
}

function AddByPath({ placeholder, onAdd, label }) {
  const [v, setV] = useState('');
  return (
    <form class="row-8 pad" onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onAdd(v.trim()); setV(''); } }}>
      <input class="mono grow" aria-label={label} placeholder={placeholder} value={v} onInput={(e) => setV(e.currentTarget.value)} />
      <button type="submit" class="btn">Add</button>
    </form>
  );
}

export function ConfigTab({ p, reload }) {
  const [compose, setCompose] = useState(p.composeFiles);
  const [envs, setEnvs] = useState(p.envFiles);
  const [profiles, setProfiles] = useState(p.profiles || []);
  const [profile, setProfile] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const dirty = JSON.stringify([compose, envs, profiles]) !== JSON.stringify([p.composeFiles, p.envFiles, p.profiles || []]);
  const command = [
    `docker compose -p ${p.name}`,
    `  --project-directory ${shq(p.directory)}`,
    compose.length ? `  ${compose.map((f) => `-f ${shq(f)}`).join(' ')}` : null,
    envs.length ? `  ${envs.map((f) => `--env-file ${shq(f)}`).join(' ')}` : null,
    profiles.length ? `  ${profiles.map((f) => `--profile ${shq(f)}`).join(' ')}` : null,
  ].filter(Boolean).join(' \\\n') + '  <command>';

  const validate = async () => {
    const r = await api('GET', `/projects/${enc(p.id)}/validate`);
    setMsg(r.ok ? { ok: 'docker compose config: valid' } : { error: r.error });
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api('PATCH', `/projects/${enc(p.id)}`, { composeFiles: compose, envFiles: envs, profiles });
      await reload();
      await validate();
    } catch (e) {
      setMsg({ error: e.message });
    }
    setBusy(false);
  };

  const addProfile = (e) => {
    e.preventDefault();
    const v = profile.trim();
    if (v && !profiles.includes(v)) setProfiles([...profiles, v]);
    setProfile('');
  };

  return (
    <div class="grid-2 align-start">
      <section class="card">
        <div class="card-head col">
          <h2>Compose files</h2>
          <p class="small muted">Checked files are passed as <code>-f</code> in this order. Later files override earlier ones.</p>
        </div>
        <FileSelector idPrefix="cf" available={p.availableComposeFiles} selected={compose} onChange={setCompose} />
        <AddByPath label="Add compose file by path" placeholder="Add by path, e.g. ../shared/compose.monitoring.yml"
          onAdd={(f) => !compose.includes(f) && setCompose([...compose, f])} />
      </section>
      <div class="stack-20">
        <section class="card">
          <div class="card-head col">
            <h2>Env files</h2>
            <p class="small muted">Passed as <code>--env-file</code> (later files win). Used for <code>${'{VAR}'}</code> substitution in the compose files. With none selected, Compose reads <code>.env</code> by default.</p>
          </div>
          <FileSelector idPrefix="ef" available={p.availableEnvFiles} selected={envs} onChange={setEnvs} />
          <AddByPath label="Add env file by path" placeholder="Add by path, e.g. /etc/myapp/prod.env"
            onAdd={(f) => !envs.includes(f) && setEnvs([...envs, f])} />
        </section>
        <section class="card pad stack-12">
          <h2>Profiles</h2>
          <form class="chips" onSubmit={addProfile}>
            {profiles.map((pr) => (
              <span class="chip accent-chip">{pr}
                <button type="button" aria-label={`Remove profile ${pr}`} onClick={() => setProfiles(profiles.filter((x) => x !== pr))}><Icon name="x" size={12} /></button>
              </span>
            ))}
            <input class="chip-input mono" aria-label="Add profile" placeholder="Add profile" value={profile} onInput={(e) => setProfile(e.currentTarget.value)} />
          </form>
        </section>
        <section class="card pad stack-12">
          <h2>Resulting command</h2>
          <pre class="code-block">{command}</pre>
          {msg?.error && <ErrorBanner>{msg.error}</ErrorBanner>}
          <div class="row-10">
            {msg?.ok && <span class="small ok row-6"><Icon name="check" size={14} />{msg.ok}</span>}
            {dirty && <span class="small warn">Unsaved changes</span>}
            <div class="grow" />
            <button type="button" class="btn" onClick={validate}>Validate</button>
            <button type="button" class="btn primary" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save configuration'}</button>
          </div>
          <p class="hint">Saving changes which files the panel passes to Compose. Run Start or Rebuild to apply them to running containers.</p>
        </section>
      </div>
    </div>
  );
}

/* ---------------- Shared file loader ---------------- */

function useProjectFile(p, file) {
  const [state, setState] = useState({ loading: true });
  const load = async () => {
    if (!file) return setState({ loading: false, content: '', exists: false });
    setState({ loading: true });
    try {
      const r = await api('GET', `/projects/${enc(p.id)}/files?path=${enc(file)}`);
      setState({ loading: false, content: r.content, exists: r.exists });
    } catch (e) {
      setState({ loading: false, error: e.message });
    }
  };
  useEffect(() => { load(); }, [p.id, file]);
  const save = (content) => api('PUT', `/projects/${enc(p.id)}/files?path=${enc(file)}`, { content });
  return [state, save, load];
}

function FilePicker({ id, label, files, value, onChange, onNew, newLabel, isUsed }) {
  return (
    <>
      <label for={id} class="small muted">{label}</label>
      <select id={id} class="mono" value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {files.map((f) => <option value={f}>{f}{isUsed(f) ? ' (active)' : ''}</option>)}
      </select>
      <button type="button" class="btn sm" onClick={onNew}><Icon name="plus" size={14} />{newLabel}</button>
    </>
  );
}

/* ---------------- Environment ---------------- */

export function EnvTab({ p, reload, initial }) {
  const { runAction } = useApp();
  const [extra, setExtra] = useState([]);
  const files = uniq([...p.envFiles, ...p.availableEnvFiles, ...extra]);
  const [file, setFile] = useState(initial && files.includes(initial) ? initial : files[0] || '');
  const [fileState, save, reloadFile] = useProjectFile(p, file);
  const [mode, setMode] = useState('table');
  const [lines, setLines] = useState([]);
  const [raw, setRaw] = useState('');
  const [original, setOriginal] = useState('');
  const [shown, setShown] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(100000);

  useEffect(() => {
    if (fileState.loading || fileState.error) return;
    setOriginal(fileState.content);
    setRaw(fileState.content);
    setLines(parseEnv(fileState.content));
    setShown({});
    setMsg(null);
  }, [fileState]);

  const current = mode === 'raw' ? raw : serializeEnv(lines);
  const norm = (s) => s.replace(/\n+$/, '');
  const dirty = !fileState.loading && norm(current) !== norm(original);
  const used = p.envFiles.includes(file);

  const switchMode = (m) => {
    if (m === mode) return;
    if (m === 'raw') setRaw(serializeEnv(lines));
    else setLines(parseEnv(raw));
    setMode(m);
  };
  const setLine = (id, patch) => setLines(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLine = () => setLines([...lines, { id: nextId.current++, key: '', value: '', isNew: true }]);

  const newFile = () => {
    const name = prompt('New env file name (e.g. .env.production or app.env):', '.env.');
    if (!name) return;
    if (!/^(\.env(\..+)?|.+\.env)$/.test(name) || name.includes('/')) return alert('Name must look like .env, .env.<name> or <name>.env');
    setExtra([...extra, name]);
    setFile(name);
  };

  const doSave = async (apply) => {
    setBusy(true);
    setMsg(null);
    try {
      await save(current);
      setOriginal(current);
      if (mode === 'table') setLines(parseEnv(current));
      setMsg({ ok: 'Saved' });
      await reload();
      if (apply) runAction(p.id, 'start');
    } catch (e) {
      setMsg({ error: e.message });
    }
    setBusy(false);
  };

  const useFile = async () => {
    try {
      await save(current);
      await api('PATCH', `/projects/${enc(p.id)}`, { envFiles: [...p.envFiles, file] });
      setOriginal(current);
      await reload();
    } catch (e) {
      setMsg({ error: e.message });
    }
  };

  const vars = lines.filter((l) => l.key !== null && !l.deleted);

  return (
    <div class="stack-16">
      <section class="card">
        <div class="toolbar">
          {files.length ? (
            <FilePicker id="env-file" label="File" files={files} value={file} onChange={(f) => (!dirty || confirm('Discard unsaved changes?')) && setFile(f)} onNew={newFile} newLabel="New env file"
              isUsed={(f) => p.envFiles.includes(f)} />
          ) : (
            <button type="button" class="btn sm" onClick={newFile}><Icon name="plus" size={14} />New env file</button>
          )}
          <div class="segmented" role="group" aria-label="Editor mode">
            <button type="button" class={mode === 'table' ? 'on' : ''} aria-pressed={mode === 'table'} onClick={() => switchMode('table')}>Table</button>
            <button type="button" class={mode === 'raw' ? 'on' : ''} aria-pressed={mode === 'raw'} onClick={() => switchMode('raw')}>Raw</button>
          </div>
          <div class="grow" />
          {file && !used && (
            <span class="small warn">Not passed to Compose. <button type="button" class="link" onClick={useFile}>Use this file</button></span>
          )}
        </div>
        {!file && <div class="empty muted">This project has no env files yet.</div>}
        {fileState.error && <div class="pad"><ErrorBanner>{fileState.error}</ErrorBanner></div>}
        {file && fileState.loading && <div class="empty muted">Loading…</div>}
        {file && !fileState.loading && !fileState.error && mode === 'raw' && (
          <textarea class="code editor" aria-label={`Contents of ${file}`} spellcheck={false} value={raw} onInput={(e) => setRaw(e.currentTarget.value)} />
        )}
        {file && !fileState.loading && !fileState.error && mode === 'table' && (
          <div class="table env-table">
            <div class="thead"><span>Key</span><span>Value</span><span /></div>
            {!vars.length && <div class="empty muted small">No variables yet.</div>}
            {vars.map((l) => {
              const changed = l.isNew || !l.orig || l.orig.key !== l.key || l.orig.value !== l.value;
              const secret = isSecretKey(l.key) && !shown[l.id];
              return (
                <div class={`trow ${changed ? 'changed' : ''}`} key={l.id}>
                  <input class="mono" aria-label="Variable name" value={l.key} placeholder="NAME"
                    onInput={(e) => setLine(l.id, { key: e.currentTarget.value })} />
                  <input class="mono" aria-label={`Value of ${l.key}`} type={secret ? 'password' : 'text'} value={l.value}
                    onInput={(e) => setLine(l.id, { value: e.currentTarget.value })} />
                  <div class="actions">
                    <IconButton icon={shown[l.id] ? 'eyeOff' : 'eye'} label={`${shown[l.id] ? 'Hide' : 'Show'} ${l.key}`}
                      onClick={() => setShown({ ...shown, [l.id]: !shown[l.id] })} />
                    <IconButton icon="trash" tone="danger" label={`Remove ${l.key}`} onClick={() => setLine(l.id, { deleted: true })} />
                  </div>
                </div>
              );
            })}
            <div class="pad"><button type="button" class="btn sm dashed" onClick={addLine}><Icon name="plus" size={14} />Add variable</button></div>
          </div>
        )}
      </section>
      {msg?.error && <ErrorBanner>{msg.error}</ErrorBanner>}
      {file && (
        <div class={`savebar ${dirty ? 'dirty' : ''}`}>
          <span class="grow small">
            {dirty ? `Unsaved changes in ${file}. Containers pick up new values only when they are recreated.` : msg?.ok ? `${file} saved.` : `${file}${fileState.exists === false ? ' (new file)' : ''}`}
          </span>
          <button type="button" class="btn" disabled={!dirty || busy} onClick={() => { setLines(parseEnv(original)); setRaw(original); }}>Discard</button>
          <button type="button" class="btn outline" disabled={!dirty || busy} onClick={() => doSave(false)}>Save</button>
          <button type="button" class="btn primary" disabled={!dirty || busy} onClick={() => doSave(true)}>Save &amp; apply (up -d)</button>
        </div>
      )}
    </div>
  );
}

/* ---------------- Files (compose editor) ---------------- */

export function FilesTab({ p, reload, initial }) {
  const { runAction } = useApp();
  const [extra, setExtra] = useState([]);
  const files = uniq([...p.composeFiles, ...p.availableComposeFiles, ...extra]);
  const [file, setFile] = useState(initial && files.includes(initial) ? initial : files[0] || '');
  const [fileState, save] = useProjectFile(p, file);
  const [text, setText] = useState('');
  const [original, setOriginal] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (fileState.loading || fileState.error) return;
    setText(fileState.content);
    setOriginal(fileState.content);
    setMsg(null);
  }, [fileState]);

  const dirty = text !== original;
  const used = p.composeFiles.includes(file);

  const newFile = () => {
    const name = prompt('New compose file name (e.g. compose.override.yml):', 'compose.override.yml');
    if (!name) return;
    if (!/^[\w.-]+\.ya?ml$/.test(name)) return alert('Name must end in .yml or .yaml');
    setExtra([...extra, name]);
    setFile(name);
  };

  const doSave = async (apply) => {
    setBusy(true);
    setMsg(null);
    try {
      await save(text);
      setOriginal(text);
      setMsg({ ok: used ? 'Saved and validated with docker compose config.' : 'Saved.' });
      await reload();
      if (apply) runAction(p.id, 'start');
    } catch (e) {
      setMsg({ error: e.message });
    }
    setBusy(false);
  };

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (dirty && !busy) doSave(false);
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: end } = el;
      const next = text.slice(0, s) + '  ' + text.slice(end);
      setText(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
    }
  };

  return (
    <div class="stack-16">
      <section class="card">
        <div class="toolbar">
          <FilePicker id="compose-file" label="File" files={files} value={file} onChange={(f) => (!dirty || confirm('Discard unsaved changes?')) && setFile(f)} onNew={newFile} newLabel="New compose file"
            isUsed={(f) => p.composeFiles.includes(f)} />
          <div class="grow" />
          {file && !used && <span class="small warn">Not selected in Configuration, so Compose ignores it.</span>}
        </div>
        {fileState.error && <div class="pad"><ErrorBanner>{fileState.error}</ErrorBanner></div>}
        {fileState.loading ? <div class="empty muted">Loading…</div> : (
          <textarea class="code editor tall" aria-label={`Contents of ${file}`} spellcheck={false} value={text}
            onInput={(e) => setText(e.currentTarget.value)} onKeyDown={onKeyDown} />
        )}
      </section>
      {msg?.error && <ErrorBanner>{msg.error}</ErrorBanner>}
      <div class={`savebar ${dirty ? 'dirty' : ''}`}>
        <span class="grow small">{dirty ? `Unsaved changes in ${file}.` : msg?.ok || file}</span>
        <button type="button" class="btn" disabled={!dirty || busy} onClick={() => setText(original)}>Discard</button>
        <button type="button" class="btn outline" disabled={!dirty || busy} onClick={() => doSave(false)}>Save</button>
        <button type="button" class="btn primary" disabled={!dirty || busy} onClick={() => doSave(true)}>Save &amp; apply (up -d)</button>
      </div>
    </div>
  );
}

/* ---------------- Logs ---------------- */

const MAX_LINES = 5000;
const MAX_PARTIAL = 64 * 1024; // a "line" with no newline yet (progress output) is cut here

let lineSeq = 0;
/** Split "service-1  | text" once on arrival instead of on every render; `id` keys the row. */
function logLine(raw) {
  const m = raw.match(/^(\S+)\s+\|\s?(.*)$/);
  return { id: ++lineSeq, raw, svc: m ? m[1] : null, color: m ? colorFor(m[1]) : null, text: m ? m[2] : raw };
}

export function LogsTab({ p, initialService }) {
  const services = uniq([...p.services, ...p.containers.map((c) => c.service)]);
  const [service, setService] = useState(initialService && services.includes(initialService) ? initialService : '');
  const [tail, setTail] = useState('200');
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [filter, setFilter] = useState('');
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('');
  const box = useRef();

  useEffect(() => {
    const ctrl = new AbortController();
    let buf = [];
    let partial = '';
    let timer = 0;
    const flush = () => {
      clearTimeout(timer);
      timer = 0;
      const add = buf;
      buf = [];
      setLines((prev) => {
        const next = prev.concat(add);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    // Batch updates: repainting a tall log box is the expensive part, so a chatty service is drawn
    // a few times a second rather than on every chunk. A timer (not requestAnimationFrame) keeps
    // flushing in background tabs, and `buf` is trimmed as lines arrive, so it stays bounded.
    const schedule = () => {
      if (!timer) timer = setTimeout(flush, document.hidden ? 1000 : 150);
    };
    const add = (raws) => {
      for (const r of raws) buf.push(logLine(r));
      if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
    };
    setLines([]);
    setStatus(follow ? 'following' : 'loading');
    const qs = new URLSearchParams({ tail, follow: follow ? '1' : '0', timestamps: timestamps ? '1' : '0' });
    if (service) qs.set('service', service);
    stream('GET', `/projects/${enc(p.id)}/logs?${qs}`, undefined, (ev) => {
      if (ev.t === 'out') {
        const parts = (partial + ev.d).split('\n');
        partial = parts.pop();
        if (partial.length > MAX_PARTIAL) {
          parts.push(partial);
          partial = '';
        }
        add(parts);
        schedule();
      } else if (ev.t === 'exit') {
        if (partial) add([partial]);
        partial = '';
        flush();
        setStatus('ended');
      }
    }, ctrl.signal).catch((e) => { if (e.name !== 'AbortError') setStatus(`error: ${e.message}`); });
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [p.id, service, tail, follow, timestamps]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? lines.filter((l) => l.raw.toLowerCase().includes(q)) : lines;
  }, [lines, filter]);

  // Before paint: trimming old rows makes the browser's scroll anchoring pull the view up by the
  // removed height, which would show as a jump for one frame.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [shown, follow]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([lines.map((l) => l.raw).join('\n')], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${p.name}${service ? '-' + service : ''}.log` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section class="card logs-card">
      <div class="toolbar wrap">
        <label for="log-svc" class="small muted">Service</label>
        <select id="log-svc" value={service} onChange={(e) => setService(e.currentTarget.value)}>
          <option value="">All services</option>
          {services.map((s) => <option value={s}>{s}</option>)}
        </select>
        <label for="log-tail" class="small muted">Tail</label>
        <select id="log-tail" value={tail} onChange={(e) => setTail(e.currentTarget.value)}>
          <option value="200">200 lines</option>
          <option value="1000">1000 lines</option>
          <option value="5000">5000 lines</option>
          <option value="all">All</option>
        </select>
        <label class="check small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />Follow</label>
        <label class="check small"><input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.currentTarget.checked)} />Timestamps</label>
        <div class="grow" />
        <label class="search sm">
          <Icon name="search" size={14} />
          <input type="search" aria-label="Filter log lines" placeholder="Filter lines" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
        </label>
        <button type="button" class="btn sm" onClick={() => setLines([])}>Clear</button>
        <IconButton icon="download" label="Download logs" onClick={download} />
      </div>
      <div class="log-box" ref={box} role="log" aria-label="Container logs">
        {shown.map((l) => (l.svc
          ? <div class="log-line" key={l.id}><span class="log-svc" style={{ color: l.color }}>{l.svc} |</span><span>{l.text}</span></div>
          : <div class="log-line" key={l.id}><span>{l.text}</span></div>))}
        <div class="log-status small faint">
          {status === 'following' && <><span class="dot live" /> Following · docker compose logs -f</>}
          {status === 'loading' && 'Loading…'}
          {status === 'ended' && (follow ? 'Stream ended (no running containers?)' : `${lines.length} lines`)}
          {status.startsWith('error') && <span class="err">{status}</span>}
        </div>
      </div>
    </section>
  );
}

const PALETTE = ['#7cbcff', '#c9a3f5', '#f3b46a', '#5fdca4', '#ff9b94', '#7fd6e0', '#e6c86e', '#b3bdf7'];
function colorFor(name) {
  let h = 0;
  for (const ch of name.replace(/-\d+$/, '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
