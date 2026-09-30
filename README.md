# Local Dev Hub

One local dashboard for every project on your machine: what's running, on which
port, how to start it, and one-click **Magic Login** as any development persona.

Built with [TanStack Start](https://tanstack.com/start) (React, server functions,
Nitro). Runs on `http://localhost:6969` and only accepts requests from this machine.

| Page | What it shows |
| --- | --- |
| **Projects** (`/`) | Every registered project with Running/Partial/Stopped status, services, git branch, Open App, Start/Stop/Restart and Magic Login. Also lists unknown services. |
| **Project detail** | Repository, branch and git status, stack, services with status details, links, personas, scenarios, commands with live log output, and other processes running inside the repo. |
| **Ports** (`/ports`) | Every listening TCP port: process, PID, working directory and owning project. Unknown ones get a **Register project** button. |
| **Settings** | Register or remove repositories, and the Magic Login public key to paste into your apps. |

## Quick start

```bash
pnpm install
pnpm dev                  # http://localhost:6969, with hot reload
```

To try every feature, open **Settings → Add project**, enter
`<this repo>/examples/demo-app`, then open **Demo App**:
**I trust these commands → Start → Magic Login → Member**.

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

Put a `.dev/project.yaml` in the repository (commit it; it contains no secrets):

```yaml
name: Fitbase
description: Gym Management SaaS
services:
  web: { label: Web, url: http://localhost:3000 }
  api: { label: API, url: http://localhost:8000, healthcheck: http://localhost:8000/up }
  postgres: { label: Postgres, port: 5432, container: fitbase-db }
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
```

Then register the folder from **Settings**, or add `scanDirs: [~/Projects]` to
`~/.config/devhub/config.yaml` to pick up every `~/Projects/*/.dev/project.yaml`
automatically.

[`examples/fitbase/.dev/project.yaml`](examples/fitbase/.dev/project.yaml)
documents every option: service kinds, healthchecks, Docker containers,
port-less workers, links, `longRunning` commands, `cwd`, and scenarios.

### How status works

| Service config | Running when… |
| --- | --- |
| `url` / `port` | something listens on the port (lsof, falling back to a TCP probe) |
| `+ healthcheck` | …and the URL answers < 400; otherwise **Error** |
| `container` | `docker ps` reports the container as running |
| `command` | the hub-managed `longRunning` command is running |

A project is **Running** when all its checkable services are, **Partial** when
some are, and **Stopped** when none are.

Listening ports are linked to projects by configured port first, then by the
process's working directory being inside the repository. For Docker, the
container's compose `working_dir` label is used instead, because published
ports belong to the Docker VM process.

### Commands

- **Start** runs `commands.start`. Mark dev servers `longRunning: true`; the hub
  keeps the process and shows its output live.
- **Stop** kills the hub's long-running processes (the whole process group), then
  runs `commands.stop` if there is one.
- **Restart** runs `commands.restart`, or Stop then Start.
- Commands run with the environment of your **login shell** (captured once), so
  `nvm`, `pnpm`, Homebrew and friends are on PATH even under launchd.
- The hub's own `PORT`, `HOST` and `NODE_ENV` are **not** passed to commands.

> **Trust:** a cloned repo's `project.yaml` can contain any command, so the hub
> won't run anything until you click **I trust these commands**. Trust is pinned
> to a hash of the commands, so editing them asks for review again.

## Magic Login

```
Hub (private key)  ── signs 60s JWT {aud: project, sub: persona.user, jti} ──▶
  browser opens http://localhost:8000/__devhub/login?token=…
    app (public key) verifies signature, audience, expiry, single use
      → finds the user → normal session → redirect
```

1. Copy `DEVHUB_PUBLIC_KEY=…` from **Settings** into the app's **development**
   `.env`. It's a public key: it can verify tokens but never create them.
2. Add the dev-only endpoint using an adapter:
   - **Node / Next.js / Express:** [`adapters/node/devhub-magic-login.ts`](adapters/node/devhub-magic-login.ts)
     (zero dependencies). Mount the route only when `isDevhubLoginEnabled()`, which
     requires `NODE_ENV=development` *and* the key.
   - **Laravel:** [`adapters/laravel/`](adapters/laravel), `DevhubToken` plus a
     controller registered only in the `local` environment.
3. Add `personas` and `magicLogin.endpoint` to `.dev/project.yaml`.

Tokens are only sent to `localhost`, `127.x`, `::1`, `*.localhost` and `*.test`
endpoints. Production safety comes from the app side: the route doesn't exist
unless the app is in development *and* has the key, and the verifier also refuses
to run with `NODE_ENV=production`.

**Scenarios** chain the two: **Load & Login** runs the scenario's `seed` command,
waits for it to succeed, then logs in as its persona.

## Security model

The hub can run shell commands, so it is locked down to this machine:

- It binds to `127.0.0.1` only.
- Every request, including pages, server functions and the log stream, must have
  a loopback `Host` header (blocks DNS rebinding) and, when present, a loopback
  `Origin`. `Sec-Fetch-Site: cross-site` is rejected except for top-level
  navigation, which blocks CSRF from other sites open in your browser.
  See [`src/server/security.ts`](src/server/security.ts).
- Commands only run after the trust review described above, and a command's
  `cwd` cannot escape its repository.
- "Open in editor/Finder/Terminal" only opens registered repository paths, never
  a path sent by the client.
- Hub state lives in `~/.config/devhub` (`DEVHUB_HOME` overrides it). The Magic
  Login private key is written with mode `0600`.

## Development

```bash
pnpm dev          # hub with hot reload on :6969
pnpm test         # vitest: parsers, config, security guard, token round-trips (Node + PHP)
pnpm typecheck
pnpm check        # biome lint + format
pnpm build && pnpm start
```

```
src/
  server/            server-only modules (never bundled for the browser)
    registry.ts      hub config + .dev/project.yaml loading and validation
    schema.ts        zod schemas for both files
    ports.ts         lsof/ps port and process detection
    docker.ts        docker ps parsing
    git.ts           branch / dirty / ahead-behind
    status.ts        service and project status, port → project mapping
    runner.ts        command process manager (process groups, log buffers, login-shell env)
    magic-login.ts   Ed25519 key management and token signing
    trust.ts         command trust pinning
    security.ts      Host/Origin/Sec-Fetch guard
  lib/api.ts         server functions (the RPC surface used by the UI)
  routes/            pages + /api/runs/$runId/logs (SSE)
  start.ts           global request middleware
adapters/            Magic Login verifiers to copy into your apps
examples/            demo-app (runnable) and fitbase (reference config)
scripts/launchd.mjs  macOS LaunchAgent installer
```

## Limitations and next steps

- Supported on macOS and Linux. Windows isn't supported yet: reading a process's
  working directory there needs native APIs.
- `lsof` only sees your own user's processes. Services running as root (for
  example a system Postgres) still show as running through the TCP probe, but
  without process details.
- Processes started by the hub are tracked in memory. They are stopped when the
  hub exits. If the hub crashes, restart them from the dashboard.
- **Next:** a menu-bar app (Tauri v2) that wraps this same UI and backend as a
  sidecar, plus native notifications when a service goes down.
