import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, setUnauthorizedHandler, stream, enc } from './api.js';
import { Icon } from './icons.jsx';
import { AppContext, OutputDrawer, refresh } from './ui.jsx';
import { Login } from './pages/Login.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { Project } from './pages/Project.jsx';

const ACTION_LABEL = {
  start: 'Start', stop: 'Stop', restart: 'Restart', rebuild: 'Rebuild', down: 'Down', pull: 'Pull', update: 'Pull & update',
};
const MAX_OUTPUT = 400_000;

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out
  const [info, setInfo] = useState(null);
  const [run, setRun] = useState(null);
  const running = useRef(false);
  const hash = useHash();

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api('GET', '/me').then(setUser, () => setUser(null));
  }, []);

  useEffect(() => {
    if (user) api('GET', '/info').then(setInfo, () => {});
  }, [user]);

  const logout = async () => {
    await api('POST', '/logout').catch(() => {});
    setUser(null);
    location.hash = '';
  };

  /** Run a compose action and stream its output into the drawer. */
  const runAction = useCallback(async (projectId, action, opts = {}) => {
    if (running.current) {
      alert('Another action is still running. Wait for it to finish.');
      return false;
    }
    running.current = true;
    const title = `${ACTION_LABEL[action] || action}${opts.service ? ` ${opts.service}` : ''} · ${projectId}`;
    const state = { title, parts: [], code: null, ms: 0, size: 0 };
    let frame = 0;
    const flush = () => { frame = 0; setRun({ ...state, parts: [...state.parts] }); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(flush); };
    flush();
    try {
      await stream('POST', `/projects/${enc(projectId)}/actions/${action}`, opts, (ev) => {
        if (ev.t === 'cmd') state.parts.push({ cmd: true, text: ev.d });
        else if (ev.t === 'out') {
          state.size += ev.d.length;
          const big = state.size > MAX_OUTPUT && state.parts.find((x) => !x.cmd && x.text.length > 10_000);
          if (big) {
            const cut = big.text.length >> 1;
            big.text = '…\n' + big.text.slice(cut);
            state.size -= cut;
          }
          const last = state.parts[state.parts.length - 1];
          if (last && !last.cmd) last.text += ev.d;
          else state.parts.push({ text: ev.d });
        } else if (ev.t === 'exit') {
          state.code = ev.code;
          state.ms = ev.ms;
        }
        schedule();
      });
      if (state.code === null) state.code = -1;
    } catch (e) {
      state.parts.push({ text: `\n${e.message}\n` });
      state.code = -1;
      state.error = true;
    } finally {
      running.current = false;
      cancelAnimationFrame(frame);
      flush();
      refresh();
    }
    return state.code === 0;
  }, []);

  if (user === undefined) return <div class="boot" />;
  if (!user) return <Login onLogin={setUser} />;

  const m = hash.match(/^#\/p\/([^/]+)(?:\/(\w+))?(?:\/([^/]+))?/);
  const page = m
    ? <Project key={m[1]} id={decodeURIComponent(m[1])} tab={m[2] || 'overview'} arg={m[3] && decodeURIComponent(m[3])} />
    : <Dashboard />;

  return (
    <AppContext.Provider value={{ runAction, info, user, running: run?.code === null }}>
      <div class={`shell ${run ? 'with-drawer' : ''}`}>
        <header class="topbar">
          <a href="#/" class="brand">
            <Icon name="logo" size={22} class="accent" />
            <span>Docker Panel</span>
          </a>
          <nav><a href="#/" class="nav-link active">Projects</a></nav>
          <div class="grow" />
          {info && (
            <span class="mono small muted hide-sm" title={info.error || ''}>
              {info.hostname} · {info.compose ? `Compose ${info.compose}` : 'Docker unreachable'}
            </span>
          )}
          <span class="small hide-sm">{user.email}</span>
          <button type="button" class="btn ghost" onClick={logout}><Icon name="logout" />Sign out</button>
        </header>
        {page}
        {run && <OutputDrawer run={run} onClose={() => run.code !== null && setRun(null)} />}
      </div>
    </AppContext.Provider>
  );
}
