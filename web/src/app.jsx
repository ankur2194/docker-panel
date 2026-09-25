import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, setUnauthorizedHandler, stream, enc } from './api.js';
import { Icon } from './icons.jsx';
import { AppContext, OutputDrawer, refresh, ThemeMenu } from './ui.jsx';
import { Login } from './pages/Login.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { Monitor } from './pages/Monitor.jsx';
import { Cleanup } from './pages/Cleanup.jsx';
import { Project } from './pages/Project.jsx';

const ACTION_LABEL = {
  start: 'Start', up: 'Up', stop: 'Stop', restart: 'Restart', rebuild: 'Rebuild', down: 'Down', pull: 'Pull', update: 'Pull & update',
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

  /** POST to a streaming endpoint and show its output in the drawer. Resolves true on exit code 0. */
  const runStream = useCallback(async (path, body, title) => {
    if (running.current) {
      alert('Another action is still running. Wait for it to finish.');
      return false;
    }
    running.current = true;
    const state = { title, parts: [], code: null, ms: 0, size: 0 };
    let frame = 0;
    const flush = () => { frame = 0; setRun({ ...state, parts: [...state.parts] }); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(flush); };
    flush();
    try {
      await stream('POST', path, body, (ev) => {
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

  /** Run a compose action (opts.services narrows it) and stream its output into the drawer. */
  const runAction = useCallback((projectId, action, opts = {}) => {
    const s = opts.services || [];
    const who = s.length ? ` ${s.slice(0, 3).join(', ')}${s.length > 3 ? ` +${s.length - 3}` : ''}` : '';
    return runStream(`/projects/${enc(projectId)}/actions/${action}`, opts, `${ACTION_LABEL[action] || action}${who} · ${projectId}`);
  }, [runStream]);

  if (user === undefined) return <div class="boot" />;
  if (!user) return <Login onLogin={setUser} />;

  const m = hash.match(/^#\/p\/([^/]+)(?:\/(\w+))?(?:\/([^/]+))?/);
  const section = m ? 'projects' : /^#\/monitor\b/.test(hash) ? 'monitor' : /^#\/cleanup\b/.test(hash) ? 'cleanup' : 'projects';
  const page = m
    ? <Project key={m[1]} id={decodeURIComponent(m[1])} tab={m[2] || 'overview'} arg={m[3] && decodeURIComponent(m[3])} />
    : { monitor: <Monitor />, cleanup: <Cleanup /> }[section] || <Dashboard />;
  const navLink = (key, href, label) => (
    <a href={href} class={`nav-link ${section === key ? 'active' : ''}`} aria-current={section === key ? 'page' : undefined}>{label}</a>
  );

  return (
    <AppContext.Provider value={{ runAction, runStream, info, user, running: run?.code === null }}>
      <div class={`shell ${run ? 'with-drawer' : ''}`}>
        <header class="topbar">
          <a href="#/" class="brand">
            <Icon name="logo" size={22} class="accent" />
            <span>Docker Panel</span>
          </a>
          <nav class="topnav">
            {navLink('projects', '#/', 'Projects')}
            {navLink('monitor', '#/monitor', 'Monitor')}
            {navLink('cleanup', '#/cleanup', 'Cleanup')}
          </nav>
          <div class="grow" />
          {info && (
            <span class="mono small muted hide-sm" title={info.error || ''}>
              {info.hostname} · {info.compose ? `Compose ${info.compose}` : 'Docker unreachable'}
            </span>
          )}
          <span class="small hide-sm">{user.email}</span>
          <ThemeMenu />
          <button type="button" class="btn ghost signout" onClick={logout} aria-label="Sign out" title="Sign out"><Icon name="logout" /><span class="hide-sm">Sign out</span></button>
        </header>
        {page}
        {run && <OutputDrawer run={run} onClose={() => run.code !== null && setRun(null)} />}
      </div>
    </AppContext.Provider>
  );
}
