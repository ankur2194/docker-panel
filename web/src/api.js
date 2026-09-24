const HEADERS = { 'X-Requested-With': 'docker-panel' };

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

function request(method, path, body, signal) {
  const headers = body === undefined ? HEADERS : { ...HEADERS, 'Content-Type': 'application/json' };
  return fetch('/api' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });
}

async function fail(res, path) {
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') onUnauthorized();
  throw new ApiError(res.status, data.error || res.statusText);
}

export async function api(method, path, body) {
  const res = await request(method, path, body);
  if (!res.ok) await fail(res, path);
  return res.json();
}

/** Reads an NDJSON stream ({t:'cmd'|'out'|'exit', ...} per line) and calls onEvent for each line. */
export async function stream(method, path, body, onEvent, signal) {
  const res = await request(method, path, body, signal);
  if (!res.ok) await fail(res, path);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

export const enc = encodeURIComponent;
