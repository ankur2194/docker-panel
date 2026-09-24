import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { ErrorBanner, Modal } from '../ui.jsx';

export function DiscoverModal({ onClose, onDone }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState({});
  const [names, setNames] = useState({});
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(false);

  const scan = async () => {
    setData(null);
    setError('');
    try {
      const d = await api('GET', '/discover');
      setData(d);
      setSelected(Object.fromEntries(d.candidates.filter((c) => c.source === 'docker').map((c) => [c.directory, true])));
      setNames(Object.fromEntries(d.candidates.map((c) => [c.directory, c.name])));
      setResults({});
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => { scan(); }, []);

  const importOne = (c) => api('POST', '/projects/import', {
    name: names[c.directory], directory: c.directory, composeFiles: c.composeFiles, source: c.source === 'docker' ? 'docker' : 'manual',
  });

  const importSelected = async () => {
    setBusy(true);
    const out = {};
    for (const c of data.candidates.filter((c) => selected[c.directory])) {
      try {
        await importOne(c);
        out[c.directory] = { ok: true };
      } catch (e) {
        out[c.directory] = { error: e.message };
      }
    }
    setResults(out);
    setBusy(false);
    onDone();
    if (Object.values(out).every((r) => r.ok)) onClose();
  };

  const addPath = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api('POST', '/projects/import', { directory: path.trim() });
      setPath('');
      onDone();
      scan();
    } catch (err) {
      setError(err.message);
    }
  };

  const count = Object.values(selected).filter(Boolean).length;
  return (
    <Modal title="Discover & import" width={820} onClose={onClose}
      subtitle={`Projects Docker already knows about${data?.scanRoots?.length ? `, plus folders under ${data.scanRoots.join(', ')}` : ''}. Nothing is started or changed on import.`}
      actions={<button type="button" class="btn sm" onClick={scan}><Icon name="restart" />Rescan</button>}
      footer={
        <>
          <span class="grow small muted">{count} selected</span>
          <button type="button" class="btn" onClick={onClose}>Cancel</button>
          <button type="button" class="btn primary" disabled={!count || busy} onClick={importSelected}>
            {busy ? 'Importing…' : `Import ${count || ''} project${count === 1 ? '' : 's'}`}
          </button>
        </>
      }>
      <ErrorBanner>{error || data?.dockerError}</ErrorBanner>
      <div class="list">
        {!data && !error && <div class="empty muted">Scanning…</div>}
        {data && !data.candidates.length && (
          <div class="empty muted">Nothing new found. Every running Compose project is already registered.</div>
        )}
        {data?.candidates.map((c) => (
          <div class="list-row" key={c.directory}>
            <input type="checkbox" aria-label={`Select ${c.name}`} checked={!!selected[c.directory]}
              onChange={(e) => setSelected({ ...selected, [c.directory]: e.currentTarget.checked })} />
            <div class="grow stack-4 min0">
              <input class="inline-input strong" aria-label="Project name" value={names[c.directory]}
                onInput={(e) => setNames({ ...names, [c.directory]: e.currentTarget.value })} />
              <span class="mono small muted ellipsis" title={c.composeFiles.join(', ')}>{c.composeFiles.join(', ')}</span>
              {results[c.directory]?.error && <span class="small err">{results[c.directory].error}</span>}
            </div>
            <span class="chip">{c.source === 'docker' ? 'docker compose ls' : c.source}</span>
            <span class={`small status-text ${/running/.test(c.status) ? 'ok' : 'muted'}`}>{c.status || 'not created'}</span>
          </div>
        ))}
      </div>
      <form class="field add-path" onSubmit={addPath}>
        <label for="d-path">Or add an existing directory</label>
        <div class="row-8">
          <input id="d-path" class="mono grow" placeholder="/home/deploy/some-app" value={path} required
            onInput={(e) => setPath(e.currentTarget.value)} />
          <button type="submit" class="btn">Add</button>
        </div>
        <span class="hint">The folder must contain a compose file (compose.yml, docker-compose.yml…). Pick others later in Configuration.</span>
      </form>
    </Modal>
  );
}
