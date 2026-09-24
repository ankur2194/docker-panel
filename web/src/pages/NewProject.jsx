import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { ErrorBanner, Modal, useApp } from '../ui.jsx';

const TEMPLATES = {
  empty: { label: 'Empty', compose: 'services:\n  app:\n    image: \n    restart: unless-stopped\n', env: '' },
  single: {
    label: 'Single image',
    compose: `services:
  web:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "\${PORT:-8080}:80"
`,
    env: 'PORT=8080\n',
  },
  postgres: {
    label: 'Postgres + Adminer',
    compose: `services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${DB_USER}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: \${DB_NAME}
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${DB_USER}"]
      interval: 5s
      retries: 10
  adminer:
    image: adminer
    restart: unless-stopped
    ports:
      - "\${ADMINER_PORT:-8081}:8080"
    depends_on:
      db:
        condition: service_healthy

volumes:
  db-data:
`,
    env: 'DB_USER=app\nDB_PASSWORD=change-me\nDB_NAME=app\nADMINER_PORT=8081\n',
  },
};

const joinPath = (dir, name) => `${dir.replace(/\/+$/, '')}/${name}`;

export function NewProjectModal({ onClose }) {
  const { info, runAction } = useApp();
  const base = info?.defaultProjectsDir || '/opt/stacks';
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [dirTouched, setDirTouched] = useState(false);
  const [composeFile, setComposeFile] = useState('compose.yml');
  const [template, setTemplate] = useState('single');
  const [compose, setCompose] = useState(TEMPLATES.single.compose);
  const [env, setEnv] = useState(TEMPLATES.single.env);
  const [start, setStart] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const directory = dirTouched ? dir : joinPath(base, name || '<name>');

  const pick = (k) => {
    setTemplate(k);
    setCompose(TEMPLATES[k].compose);
    setEnv(TEMPLATES[k].env);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const p = await api('POST', '/projects', { name, directory, composeFile, compose, env });
      onClose();
      location.hash = `#/p/${encodeURIComponent(p.id)}`;
      if (start) runAction(p.id, 'start');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New project" onClose={onClose}
      footer={
        <>
          <label class="check grow"><input type="checkbox" checked={start} onChange={(e) => setStart(e.currentTarget.checked)} />Start after creating (up -d)</label>
          <button type="button" class="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="new-project" class="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button>
        </>
      }>
      <form id="new-project" class="stack-18" onSubmit={submit}>
        <ErrorBanner>{error}</ErrorBanner>
        <div class="grid-2">
          <div class="field">
            <label for="np-name">Project name</label>
            <input id="np-name" class="mono" required pattern="[a-z0-9][a-z0-9_\-]*" placeholder="my-app" value={name}
              onInput={(e) => setName(e.currentTarget.value.toLowerCase())} autofocus />
            <span class="hint">Lowercase letters, digits, - and _. Used as the Compose project name.</span>
          </div>
          <div class="field">
            <label for="np-dir">Directory on server</label>
            <input id="np-dir" class="mono" required value={directory}
              onInput={(e) => { setDirTouched(true); setDir(e.currentTarget.value); }} />
            <span class="hint">Any absolute path. Created if it does not exist.</span>
          </div>
        </div>
        <div class="field">
          <div class="row-10">
            <input aria-label="Compose file name" class="inline-input mono grow" value={composeFile}
              onInput={(e) => setComposeFile(e.currentTarget.value)} />
            <div class="segmented" role="group" aria-label="Start from template">
              {Object.entries(TEMPLATES).map(([k, t]) => (
                <button type="button" class={template === k ? 'on' : ''} aria-pressed={template === k} onClick={() => pick(k)}>{t.label}</button>
              ))}
            </div>
          </div>
          <textarea id="np-compose" aria-label="Compose file content" class="code" rows={12} spellcheck={false} value={compose}
            onInput={(e) => setCompose(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label for="np-env">.env <span class="muted">(optional)</span></label>
          <textarea id="np-env" class="code" rows={4} spellcheck={false} value={env}
            onInput={(e) => setEnv(e.currentTarget.value)} />
        </div>
      </form>
    </Modal>
  );
}
