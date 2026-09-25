import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { ThemeMenu } from '../ui.jsx';

export function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await api('POST', '/login', { email, password }));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div class="login-page">
      <div class="login-theme"><ThemeMenu /></div>
      <main class="login-card">
        <div class="stack-14">
          <div class="logo-tile"><Icon name="logo" size={24} class="accent" /></div>
          <div class="stack-6">
            <h1>Sign in to Docker Panel</h1>
            <p class="muted">Manage the Compose projects running on this server.</p>
          </div>
        </div>
        {error && (
          <div class="banner error" role="alert"><Icon name="alert" /><span>{error}</span></div>
        )}
        <form class="stack-18" onSubmit={submit}>
          <div class="field">
            <label for="email">Email</label>
            <input id="email" type="email" autocomplete="username" required autofocus placeholder="you@example.com"
              value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" type="password" autocomplete="current-password" required
              value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
          </div>
          <button type="submit" class="btn primary lg" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </main>
    </div>
  );
}
