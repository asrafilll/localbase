# Local Dev Hub

One local dashboard for every project on your machine: what's running, on which
port, how to start it, and one-click **Magic Login** as any development persona.

Built with [TanStack Start](https://tanstack.com/start) (React, server functions,
Nitro). Runs on `http://localhost:6969` and only accepts requests from this machine.
It also comes with a CLI (`devhub`), an MCP server for AI coding agents and a
macOS menu-bar app.

| Page | What it shows |
| --- | --- |
| **Projects** (`/`) | Every registered project: Running/Partial/Stopped status, services, stable URL, git branch, CPU/RAM, `.env` warnings, Start/Stop/Restart and Magic Login. Also lists unknown services. |
| **Project detail** | Repository and git status, stack, services (with Docker logs), environment check, links, personas, scenarios, database snapshots, commands with live output, and other processes running inside the repo. |
| **Ports** (`/ports`) | Every listening TCP port: process, PID, working directory and owning project. **Kill** frees a port; unknown ones get **Register project**. |
| **Settings** | Register repositories (with config auto-detection), proxy and exit behaviour, and the Magic Login public key. |

Press **⌘K** (Ctrl+K) anywhere to jump to a project, open any of its URLs,
start/stop it or log in as a persona: type `fit adm` and press Enter.

## Quick start

```bash
pnpm install
pnpm dev                  # http://localhost:6969, with hot reload
```

To try every feature, open **Settings**, enter `<this repo>/examples/demo-app`,
click **Detect config → Register project**, then on **Demo App**:
**I trust these commands → Start → Login** (Member).

### Run it permanently (macOS)

```bash
pnpm build
pnpm agent:install        # LaunchAgent: starts at login, restarts on crash
pnpm agent:uninstall
```

Logs go to `~/Library/Logs/local-dev-hub.log`. You can also open it as
`http://devhub.localhost:6969`; browsers resolve `*.localhost` to your machine
with no `/etc/hosts` edits. Avoid `dev.local`: `.local` is reserved for mDNS/Bonjour
on macOS and resolves slowly.

## Adding a project

In **Settings** (or **Register project** on an unknown port), enter the repo
folder and click **Detect config**. The hub drafts `.dev/project.yaml` from
what's already there:

- `package.json` scripts and dependencies: framework and its default port
  (Next.js, Vite, Nuxt, SvelteKit, Astro, Remix, Angular, NestJS…), `-p/--port`
  flags, `test`/`lint`/`seed`/`migrate` scripts, Storybook, monorepo `apps/*`
- the package manager from the lockfile (pnpm, yarn, bun, npm)
- `docker-compose.yml` / `compose.yaml`: Postgres, MySQL, Redis, Mailpit, MinIO…
  with their published ports
- Laravel (`artisan`, `composer run dev`, `APP_URL`, `DB_*`), Django
  (`manage.py`), Rails (`bin/rails`, `bin/dev`)
- the database from `DATABASE_URL` or Laravel's `DB_*`, written as
  `${VAR}` references so no password ends up in the file

You review and edit the draft before it's written. Commit it: it contains no
secrets. You can also write it by hand:

```yaml
name: Fitbase
description: Gym Management SaaS
services:
  web: { label: Web, url: http://localhost:3000 }
  api: { label: API, url: http://localhost:8000, healthcheck: http://localhost:8000/up }
  postgres: { label: Postgres, kind: database, port: 5432, container: fitbase-db }
personas:
  admin: { label: Super Admin, user: admin@fitbase.local }
  member: { label: Member, user: member@fitbase.local }
magicLogin:
  endpoint: http://localhost:8000/__devhub/login
  redirect: /dashboard
commands:
  start: docker compose up -d
  stop: docker compose down
  seed: php artisan db:seed
database:
  type: postgres
  url: postgres://${DB_USERNAME}:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_DATABASE}
```

Add `scanDirs: [~/Projects]` to `~/.config/devhub/config.yaml` to pick up every
`~/Projects/*/.dev/project.yaml` automatically.
[`examples/fitbase/.dev/project.yaml`](examples/fitbase/.dev/project.yaml)
documents every option.

### How status works

| Service config | Running when… |
| --- | --- |
| `url` / `port` | something listens on the port (lsof, falling back to a TCP probe) |
| `+ healthcheck` | …and the URL answers < 400; otherwise **Error** |
| `container` | `docker ps` reports the container as running |
| `command` | the hub-managed `longRunning` command is running |

If the process on a service's port was started from a *different* folder (another
project, a forgotten prototype), the service shows **Error: port taken by …**
instead of Running. Shared infrastructure (`kind: database`, `cache`, `queue`,
`mail`, `storage`) is exempt, so one Homebrew Postgres can serve several projects.

A project is **Running** when all its checkable services are, **Partial** when
some are, and **Stopped** when none are. Ports are linked to projects by
configured port, then by the process's working directory, then (for Docker) by
the compose `working_dir` label.

### Commands

- **Start** runs `commands.start`. Mark dev servers `longRunning: true`; the hub
  keeps the process and shows its output live.
- Before starting, the hub checks the project's ports. If another app holds one,
  you get **Stop it & start**, **Start anyway** or **Cancel**.
- **Stop** stops the hub-started processes (the whole process group), then runs
  `commands.stop` if there is one. **Restart** runs `commands.restart`, or Stop then Start.
- Commands run with the environment of your **login shell** (captured once), so
  `nvm`, `pnpm`, Homebrew and friends are on PATH even under launchd. The hub's
  own `PORT`, `HOST` and `NODE_ENV` are **not** passed on.
- Output goes to `~/.config/devhub/logs/`, not to a pipe, so **dev servers keep
  running when the hub restarts or crashes**. On start the hub re-attaches to
  them (marked ↺): status, logs and Stop keep working. Set
  `stopProcessesOnExit: true` in `config.yaml` to stop them when the hub quits.

> **Trust:** a cloned repo's `project.yaml` can contain any command, so the hub
> won't run anything until you click **I trust these commands**. Trust is pinned
> to a hash of the commands and the database target, so editing them asks for
> review again. The REST API, CLI and MCP server cannot grant trust.

### Stable URLs per project

The hub runs a small reverse proxy on port **6970**:

| URL | Goes to |
| --- | --- |
| `http://fitbase.localhost:6970` | the project's main URL (`url`, or its first local service URL) |
| `http://api.fitbase.localhost:6970` | the `api` service |

The URL stays the same when a dev server's port changes, and each project gets
its own origin, so login cookies of different projects no longer overwrite each
other on `localhost`. WebSockets are proxied too, so Vite/Next hot reload works.
Set `proxyPort: 80` in `config.yaml` to drop the port (`http://fitbase.localhost`;
macOS allows this without sudo), or `proxyPort: 0` to turn the proxy off. If you
want Magic Login cookies on the proxied origin, point `magicLogin.endpoint` at it too.

### Environment check

For the repo root and every command `cwd`, the hub compares the keys in
`.env.example` (or `.sample`/`.dist`/`.template`) with those set in `.env`,
`.env.local` and `.env.development*`. Missing keys appear on the card and the
project page. Only key **names** are read into the dashboard; values never leave
your files.

### Database snapshots

With a `database` section (`postgres`, `mysql` or `sqlite`), the project page can
**save**, **restore** and delete named snapshots
(`~/.config/devhub/snapshots/<project>/`):

- Postgres/MySQL use `pg_dump`/`psql` and `mysqldump`/`mysql` on the host, or
  inside the database container when you set `container:` (no local client or
  version mismatch to worry about). Passwords are passed via `PGPASSWORD`/`MYSQL_PWD`.
- SQLite uses `sqlite3 .backup` when available, otherwise a file copy; restore
  also removes stale `-wal`/`-shm` files. The path must be inside the repo.
- `url` may reference `.env` values as `${VAR}`; `urlEnv: DATABASE_URL` reads the
  whole URL from `.env`.

A scenario can use `snapshot: <name>` instead of (or before) a `seed` command, so
**Load & Login** takes seconds.

### Docker logs and resource usage

Services backed by a container (by `container:` or by compose `working_dir`) get
a **Logs** button that streams `docker logs -f`. The card and project page show
CPU and memory summed over the project's processes (hub-started process groups
and everything listening from the repo, plus children) and its containers
(`docker stats`, refreshed in the background).

## Magic Login

```
Hub (private key)  ── signs 60s JWT {aud: project, sub: persona.user, jti} ──▶
  browser opens http://localhost:8000/__devhub/login?token=…
    app (public key) verifies signature, audience, expiry, single use
      → finds the user → normal session → redirect
```

1. Copy `DEVHUB_PUBLIC_KEY=…` from **Settings** into the app's **development**
   `.env`. It's a public key: it can verify tokens but never create them.
2. Add the dev-only endpoint with an adapter from [`adapters/`](adapters):

   | Stack | Files | Registered only when |
   | --- | --- | --- |
   | Node / Express | `node/devhub-magic-login.ts` (no dependencies) | `isDevhubLoginEnabled()`: `NODE_ENV=development` + key |
   | Next.js (App Router) | `nextjs/app/api/devhub/login/route.ts` + the Node file; Auth.js example included | same (route answers 404 otherwise) |
   | Laravel | `laravel/DevhubToken.php`, `DevhubLoginController.php` | `app()->environment('local')` + key |
   | Django | `django/devhub_token.py`, `devhub_login.py` (needs `cryptography`) | `settings.DEBUG` + key |
   | Rails | `rails/devhub_token.rb`, `devhub_login_controller.rb` (OpenSSL 3) | `Rails.env.development?` + key |

   Every verifier checks the signature, issuer, audience, expiry and
   single-use `jti`, and only redirects to same-site paths.
3. Add `personas` and `magicLogin.endpoint` to `.dev/project.yaml`.

Tokens are only sent to `localhost`, `127.x`, `::1`, `*.localhost` and `*.test`
endpoints.

## CLI

```bash
pnpm link --global        # once, from this repo: puts `devhub` on your PATH
```

```
devhub                      # status of every project
devhub ports                # who is using which port
devhub start fitbase -f     # start and follow the output (--kill frees busy ports)
devhub stop | restart [project]
devhub run [project] test   # run a command from project.yaml, exit code included
devhub logs [project] -f
devhub open [project] [service]
devhub login [project] admin
devhub scenario [project] pt-seven-left
devhub snapshot [project] save clean-db
devhub kill-port 3000
```

Inside a registered repository you can omit the project. Add `--json` for
scripts. `DEVHUB_URL` points it at a hub on another port.

## MCP server (AI coding agents)

Lets Claude Code, Cursor and other MCP clients ask "which port is the API on?",
start the project, run its tests, read its logs or get a Magic Login URL:

```bash
claude mcp add devhub -- node /path/to/localbase/bin/devhub-mcp.mjs
```

Tools: `list_projects`, `get_project`, `list_ports`, `start_project`,
`stop_project`, `restart_project`, `run_command`, `get_logs`, `magic_login_url`,
`load_scenario`, `database_snapshot`, `kill_port`. When the agent works inside a
registered repo, the project argument can be omitted. Commands still need your
trust click in the dashboard, and no tool can grant it.

## Menu-bar app (macOS)

[`desktop/`](desktop) is a Tauri v2 tray app. It has no window: the menu-bar icon
shows how many projects are running, and each project has a submenu to open it,
open its services, Start/Stop/Restart it and log in as any persona. You get a
native notification when a running service goes down (except right after you
stopped it yourself). When the hub isn't reachable, **Start Local Dev Hub** starts
the LaunchAgent, or the built server from this repo.

```bash
cd desktop
npm install
npm run dev               # try it (the hub should be running)
npm run build             # → src-tauri/target/release/bundle/macos/Local Dev Hub.app
```

Needs Rust (`rustup`) and Xcode command line tools. The app is unsigned: the
first time, right-click it in Finder → **Open**. Add it to
**System Settings → General → Login Items** to start it with your Mac.

## REST API

Everything above is built on a JSON API at `/api/v1` (see
[`src/server/rest.ts`](src/server/rest.ts)): `GET overview`, `GET ports`,
`GET projects/:id`, `POST projects/:id/start|stop|restart`,
`POST projects/:id/commands/:key`, `POST projects/:id/login`,
`POST projects/:id/scenarios/:key`, `POST projects/:id/snapshots`,
`GET runs/:id?tail=`, `POST runs/:id/stop`, `POST ports/:port/kill`. POST bodies
are JSON. Live output: `GET /api/runs/:id/logs` and
`GET /api/containers/:name/logs` (Server-Sent Events).

## Security model

The hub can run shell commands, so it is locked down to this machine:

- The dashboard/API binds to `127.0.0.1` only, and so does the proxy.
- Every request, including pages, server functions, the REST API and log streams,
  must have a loopback `Host` header (blocks DNS rebinding) and, when present, a
  loopback `Origin`. `Sec-Fetch-Site: cross-site` is rejected except for top-level
  navigation, which blocks CSRF from other sites open in your browser.
  See [`src/server/security.ts`](src/server/security.ts).
- Commands and snapshot restores only run after the trust review, and a
  command's `cwd` or a SQLite path cannot escape its repository.
- **Kill** never touches the hub itself or Docker's VM/proxy processes; a port
  published by a container stops that container instead.
- "Open in editor/Finder/Terminal" only opens registered repository paths.
- Hub state lives in `~/.config/devhub` (`DEVHUB_HOME` overrides it). The Magic
  Login private key is written with mode `0600`.

## Development

```bash
pnpm dev          # hub with hot reload on :6969
pnpm test         # vitest (Django adapter tests need Python `cryptography`; PYTHON=... to pick one)
pnpm typecheck
pnpm check        # biome lint + format
pnpm build && pnpm start
```

```
src/
  server/            server-only modules (never bundled for the browser)
    actions.ts       everything the hub can do; shared by UI, REST, CLI and MCP
    rest.ts          /api/v1 routes
    registry.ts      hub config + .dev/project.yaml loading, validation, registration
    detect.ts        project.yaml auto-detection
    schema.ts        zod schemas for both files
    status.ts        service/project status, port ownership, conflicts, usage
    runner.ts        commands: process groups, log files, re-attach after restart
    proxy.ts         <project>.localhost reverse proxy (HTTP + WebSocket)
    database.ts      snapshots (pg_dump/psql, mysqldump/mysql, SQLite)
    envcheck.ts      .env vs .env.example
    ports.ts         lsof/ps port and process detection
    docker.ts        docker ps parsing, docker logs
    resources.ts     CPU/RAM from ps and docker stats
    killport.ts      free a port safely
    magic-login.ts   Ed25519 key management and token signing
    trust.ts         command trust pinning
    security.ts      Host/Origin/Sec-Fetch guard
  lib/api.ts         server functions used by the UI
  routes/            pages, /api/v1, SSE log streams
  server.ts          server entry: starts the proxy and re-attaches runs at boot
  start.ts           global request middleware
bin/                 devhub CLI and MCP server
desktop/             Tauri menu-bar app
adapters/            Magic Login verifiers to copy into your apps
examples/            demo-app (runnable) and fitbase (reference config)
scripts/launchd.mjs  macOS LaunchAgent installer
```

## Limitations

- Supported on macOS and Linux. Windows isn't supported: reading a process's
  working directory there needs native APIs.
- `lsof` only sees your own user's processes. Services running as root (for
  example a system Postgres) still show as running through the TCP probe, but
  without process details, and can't be killed from the hub.
- Runs started by the hub are re-attached after a restart, but processes started
  outside the hub (in your terminal) are only *observed*: Stop can't stop them,
  though **Kill** on the Ports page can.
- Container logs, `docker stats` and database snapshots inside containers need
  the Docker CLI on PATH.
