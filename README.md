# Docker Panel

A small web panel for managing Docker Compose projects on one server. You can:

- sign in with a single admin email and password (no sign-up or password reset);
- list every registered project with live status, wherever its folder is on disk;
- find projects that are already running (`docker compose ls`) or sitting in folders you choose, and import them;
- create new projects from a compose file and an optional `.env`;
- **start, stop, restart, rebuild** (cached, `--pull`, `--no-cache`), **pull & update**, and **down** a project, with the command output streamed live. Start reuses stopped containers; `up -d` and force-recreate are options on the Start button;
- select several services with checkboxes and run the same actions on just those, or act on one service from its row;
- choose which **compose files** (`-f`, in order) and **env files** (`--env-file`) a project uses, plus **profiles**;
- edit **environment variables** in a table (secrets hidden) or as raw text, and create new env files;
- edit compose files in the browser. Changes are checked with `docker compose config` before they are saved;
- follow **logs** for the whole project or one service;
- **monitor load** for the whole server, each project and each container (CPU, memory, disk, network, disk I/O), with auto-refresh every 2s–1m and colors for light, normal, high and overload;
- **clean up** Docker disk usage: build cache, images, stopped containers, networks and volumes, with the options each prune command offers;
- switch between a **light and dark theme**, or follow the system setting.

## Stack

| Part | Choice | Why |
|---|---|---|
| Server | Node.js ≥ 20.12 with only built-in modules (`http`, `child_process`, `crypto`) | No runtime dependencies to install or patch |
| UI | [Preact](https://preactjs.com) + Vite, plain CSS, inline SVG charts | About 33 KB gzipped in total |
| Docker | Calls the `docker compose` CLI directly, without a shell | Behaves exactly like running Compose by hand, and all Compose features work |
| Storage | A single `data/projects.json` | No database |

## Requirements

- Linux server with Docker Engine and the Compose v2 plugin (`docker compose version`)
- Node.js 20.12 or newer
- The panel must run as a user that can use Docker (root, or a member of the `docker` group)

## Setup

```bash
git clone <this repo> /opt/docker-panel && cd /opt/docker-panel
npm ci && npm run build          # builds the UI into web/dist

cp .env.example .env
npm run hash-password            # prompts for a password, prints ADMIN_PASSWORD_HASH
openssl rand -hex 32             # use as SESSION_SECRET
$EDITOR .env                     # set ADMIN_EMAIL, ADMIN_PASSWORD_HASH, SESSION_SECRET, SCAN_ROOTS…

npm start                        # http://127.0.0.1:8080
```

After the build, only `server/`, `web/dist/`, `package.json` and `.env` are needed at runtime. `node_modules` is used only for the build.

### Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Listen address. Use `127.0.0.1` behind a reverse proxy |
| `ADMIN_EMAIL` | none | Login email |
| `ADMIN_PASSWORD_HASH` | none | Output of `npm run hash-password` (scrypt) |
| `SESSION_SECRET` | random at each start | Signs session cookies. Set it, or everyone is signed out on every restart |
| `SESSION_TTL_HOURS` | `12` | Session lifetime |
| `COOKIE_SECURE` | `auto` | `auto` marks the cookie `Secure` over HTTPS (it trusts `X-Forwarded-Proto`) |
| `DATA_DIR` | `./data` | Where `projects.json` is stored |
| `SCAN_ROOTS` | none | Comma-separated folders scanned (two levels deep) by *Discover & import* |
| `DEFAULT_PROJECTS_DIR` | first scan root, or `/opt/stacks` | Parent folder pre-filled in *New project* |
| `DOCKER_BIN` | `docker` | Docker CLI to call |

Projects are **not** tied to `SCAN_ROOTS` or `DEFAULT_PROJECTS_DIR`. Every project stores its own absolute directory. You can import any folder by path, and create new projects in any folder.

### Run as a service

See [`deploy/docker-panel.service`](deploy/docker-panel.service) (systemd). Put the panel behind a TLS reverse proxy such as Caddy or nginx, for example:

```
panel.example.com {
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1   # stream action output and logs without buffering
    }
}
```

The panel can also run in a container ([`Dockerfile`](Dockerfile), [`deploy/compose.yml`](deploy/compose.yml)). In that case, mount the Docker socket, and mount every project folder at the **same path** as on the host.

## How it works

Every action runs `docker compose` with the flags saved for that project:

```
docker compose -p <name> --project-directory <dir> -f <file>… --env-file <file>… --profile <p>… <command>
```

| Button | Command(s) |
|---|---|
| Start | `start` for services that have containers, then `up -d --no-recreate` for services that don't |
| Start ▸ Up | `up -d --remove-orphans` (creates missing containers, recreates the ones whose config changed) |
| Start ▸ Up without recreating | `up -d --remove-orphans --no-recreate` |
| Start ▸ Force recreate | `up -d --remove-orphans --force-recreate` |
| Stop | `stop` |
| Restart | `restart` |
| Rebuild | `build [--pull] [--no-cache]`, then `up -d --force-recreate --remove-orphans` |
| Pull & update | `pull`, then `up -d --remove-orphans` |
| Down | `down --remove-orphans` (named volumes are kept) |
| Save & apply (env or compose file) | save the file, then `up -d` (recreates only the services that changed) |

With services selected in *Overview*, the same commands get the service names appended (for example `stop web db`). The project header buttons always act on the whole project.

Notes:

- Start never recreates an existing container, even if its configuration changed since it was created. To apply changes, use *Start ▸ Up*. `--no-recreate` is also used when creating the missing services, so their `depends_on` services are not recreated as a side effect.
- Env files chosen in *Configuration* are passed with `--env-file` and are used for `${VAR}` substitution in the compose files. Files that services load through `env_file:` in the compose file can be edited in the same way.
- If a project has no env files selected, Compose falls back to its default `.env` in the project directory.
- Docker runs with a minimal environment (PATH, HOME, `DOCKER_*`, proxy variables). This stops the panel's own settings, such as `PORT`, from overriding values in your env files.
- Only one action can run per project at a time. If you close the browser mid-action, the action still finishes.
- *Remove from panel* only removes the project from `projects.json`. Its containers and files are left alone.

### Monitoring

The *Monitor* page (and each project's *Monitoring* tab) shows live load at three levels:

| Level | Source |
|---|---|
| Server | CPU, load average, memory and swap from `/proc`; disk space with `statfs`; network from `/proc/net/dev` (container and bridge interfaces excluded) |
| Project | Sum of its containers, grouped by the `com.docker.compose.project` label |
| Container | `docker stats --no-stream`, plus CPU limits from `docker inspect` |

Every value is colored by load level, and the level is also written out as text:

| Level | Range |
|---|---|
| Light | under 25% |
| Normal | 25–60% |
| High | 60–85% |
| Overload | 85% and above |

What the percentage means:

- **Container CPU** is measured against the container's CPU limit (`cpus:`), or against all host cores if it has none. A container using 0.5 CPU with `cpus: 0.5` is therefore in overload.
- **Container memory** is measured against its memory limit, or against host RAM.
- **Project figures** are shares of the whole host.
- **Load average** is the 1-minute load divided by the number of cores.

Choose the refresh interval (Off, 2s, 5s, 10s, 30s or 1m) at the top of the page; the browser remembers it. Nothing is sampled in the background: stats are collected only while a monitoring view is open, and the charts show the history since the page was opened (the last 120 samples). Parallel requests share one `docker stats` run.

If the panel runs in a container, the server figures come from that container's view of `/proc`. CPU, load and network then describe the host only when it uses the host's PID and network namespaces. For exact server figures, run the panel directly on the host.

### Cleanup

The *Cleanup* page shows `docker system df` and runs one prune at a time, streaming its output:

| Card | Command | Options |
|---|---|---|
| Build cache | `builder prune -f` | `--all` (all cache, not just unused), age |
| Images | `image prune -f` | `-a` (every unused image, not just dangling), age |
| Stopped containers | `container prune -f` | age |
| Networks | `network prune -f` | age |
| Volumes | `volume prune -f` | `--all` (named volumes too, Docker 23+) |
| Everything unused | `system prune -f` | `-a`, `--volumes`, age |

Age is `--filter until=24h`, `168h` (7 days) or `720h` (30 days). Docker can't filter volumes by age, so the age option is off whenever volumes are included. Every prune asks for confirmation first. Removing volumes deletes their data, so those options are marked in red.

### Theme

The moon, sun or monitor button in the top bar chooses Dark, Light or System (follows the OS). The choice is saved in the browser (`localStorage`, key `dp:theme`). `web/public/theme.js` applies it before the page is drawn, so the wrong theme never flashes.

## Security

Access to this panel is effectively **root access on the server**: anyone who can edit a compose file can mount the host filesystem. Therefore:

- keep it on a private network or behind a TLS reverse proxy (plus a VPN, or IP allowlisting, if you can);
- use a strong password. Failed logins are limited to 10 per IP per 15 minutes;
- sessions are HMAC-signed, `HttpOnly`, `SameSite=Strict` cookies. Every state-changing request must also carry a custom header, which blocks cross-site requests;
- the file editor only opens compose and env files that sit directly in the project folder or that the project references.

## Development

```bash
npm install
npm run dev:server   # API on :8080 (reads .env), restarts on change
npm run dev          # Vite dev server on :5173, proxies /api to :8080
```

Layout:

```
server/   index.js (HTTP + routes) · auth.js · compose.js · projects.js · stats.js · config.js · hash-password.js
web/src/  app.jsx · api.js · env.js · load.js · theme.js · ui.jsx · monitor-ui.jsx · icons.jsx · styles.css
          pages/ Login · Dashboard · Project · ProjectTabs · Monitor · Cleanup · NewProject · Discover
web/public/ theme.js (applies the saved theme before first paint) · favicon.svg
```
