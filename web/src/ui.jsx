import { createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons.jsx';

/** Shared app services: { runAction, info, user, logout } */
export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export const refresh = () => window.dispatchEvent(new Event('dp:refresh'));

export function useRefresh(fn) {
  useEffect(() => {
    window.addEventListener('dp:refresh', fn);
    return () => window.removeEventListener('dp:refresh', fn);
  }, [fn]);
}

const STATE_LABEL = { running: 'Running', partial: 'Partial', stopped: 'Stopped', 'not-created': 'Not created' };

export function StatusPill({ state, children }) {
  return (
    <span class={`pill pill-${state}`}>
      <span class="dot" />
      {children ?? STATE_LABEL[state] ?? state}
    </span>
  );
}

export function IconButton({ icon, label, tone, ...rest }) {
  return (
    <button type="button" class={`icon-btn ${tone || ''}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

export function Modal({ title, subtitle, onClose, children, footer, width = 760, actions }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: width }}>
        <div class="modal-head">
          <div class="grow">
            <h2>{title}</h2>
            {subtitle && <p class="muted small">{subtitle}</p>}
          </div>
          {actions}
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** A small dropdown menu: items = [{ label, onClick, danger }] */
export function Menu({ label, icon = 'more', items, buttonClass = 'icon-btn', text }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div class="menu-wrap" ref={ref}>
      <button type="button" class={buttonClass} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)}>
        {text ?? <Icon name={icon} />}
      </button>
      {open && (
        <div class="menu" role="menu">
          {items.filter(Boolean).map((it) => (
            <button type="button" role="menuitem" class={it.danger ? 'danger' : ''} disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}>
              <span>{it.label}</span>
              {it.hint && <small>{it.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function OutputDrawer({ run, onClose }) {
  const pre = useRef();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const el = pre.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [run.text]);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, []);
  const copy = async () => {
    await navigator.clipboard?.writeText(run.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  let status;
  if (run.code === null) status = <span class="pill pill-running"><span class="dot pulse" />Running…</span>;
  else if (run.code === 0) status = <StatusPill state="running">Exited 0 · {(run.ms / 1000).toFixed(1)}s</StatusPill>;
  else status = <span class="pill pill-error"><span class="dot" />{run.error ? 'Failed' : `Exited ${run.code}`}</span>;
  return (
    <section class="drawer" aria-label="Action output">
      <div class="drawer-head">
        <Icon name="terminal" class="accent" />
        <strong>{run.title}</strong>
        {status}
        <div class="grow" />
        <button type="button" class="btn sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <IconButton icon="x" label="Close output" onClick={onClose} disabled={run.code === null} />
      </div>
      <pre ref={pre} class="drawer-body" role="log">
        {run.parts.map((p) => (p.cmd ? <span class="cmd">$ {p.text}{'\n'}</span> : p.text))}
      </pre>
    </section>
  );
}

export function ErrorBanner({ children }) {
  if (!children) return null;
  return (
    <div class="banner error" role="alert">
      <Icon name="alert" />
      <span class="pre-wrap">{children}</span>
    </div>
  );
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
