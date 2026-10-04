# GanttLines

A self-hostable Gantt planner in the spirit of Instagantt: a task list and a timeline side by side,
live collaboration, dependencies that push dates, working-day calendars with holidays and time off,
baselines and share links. One app container plus PostgreSQL.

## Run it

You need Docker with Compose v2.20 or newer. Only `docker-compose.yml` and `.env` are needed on
the server; the app image comes from `ghcr.io/d-martins/ganttlines`.

```sh
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, SESSION_SECRET (e.g. openssl rand -hex 24 / openssl rand -hex 32)
# and the first admin: ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD
docker compose up -d
```

Open <http://localhost:3000> and sign in as that admin. (You can then remove `ADMIN_PASSWORD` from
`.env`; it's only used to create the account on the first start.)

Left the `ADMIN_*` settings empty? Then the first visitor creates the admin in the browser — but
only with the one-time **setup code** the server prints in its log
(`docker compose logs app | grep "setup code"`), so nobody else can claim a fresh install.

| Task | Command |
| --- | --- |
| Stop / start | `docker compose stop` · `docker compose start` |
| Logs | `docker compose logs -f app` |
| Version | `docker compose exec app ganttlines version` (also under Settings → About) |

### Settings (`.env`)

| Variable | Meaning |
| --- | --- |
| `COMPOSE_PROFILES=bundled-db` | Run the bundled PostgreSQL. Remove it to use your own database. |
| `POSTGRES_PASSWORD` | Password of the bundled database (letters and digits). |
| `DATABASE_URL` | Your own PostgreSQL instead, e.g. `postgresql://user:pass@host:5432/ganttlines?sslmode=require`. |
| `SESSION_SECRET` | Required, 32+ characters. Changing it signs everyone out. |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | The first admin, created on the first start (8+ character password). Ignored once anyone has an account. |
| `OIDC_*` | Single sign-on — see [Single sign-on](#single-sign-on-google-and-others). |
| `SMTP_*`, `MAIL_FROM` | Email — see [Email](#email). |
| `PUBLIC_URL` | The address people open, e.g. `https://plan.example.com`. |
| `HOST_BIND`, `HOST_PORT` | Where it listens on this machine (default `127.0.0.1:3000`, this computer only). |
| `TRUST_PROXY` | Behind a reverse proxy: how many proxies to trust (e.g. `1`). |
| `BACKUP_BEFORE_MIGRATE` | `true` (default): back up automatically before upgrading the database. |

### Your own PostgreSQL

Delete the `COMPOSE_PROFILES` line, set `DATABASE_URL` and start as usual; only the app container
runs. Use PostgreSQL 13 or newer and an empty database the user owns. A database on this same
machine is reachable from the container as `host.docker.internal`.

## Locations and public holidays

Under Team & calendar → **Locations**, add the offices or countries people work in and put each
team member in one. A holiday can be for everyone, for some people, or for whole locations — and
it follows people when they move. Give a location a country (and region, where holidays differ by
region) and **Public holidays…** suggests that year's holidays: the days off by law come ticked,
others (observances, bank or school holidays) can be ticked too. Added holidays are ordinary
holidays — rename, move or delete them as needed, and check them against official sources.

Holiday data comes from [date-holidays](https://github.com/commenthol/date-holidays) (data under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)), included in the app — nothing is
fetched from the internet.

## Email

With email set up, new users get an invitation to choose their own password (no temporary
passwords to pass on) and the sign-in page offers **Forgot your password?**. Any SMTP service
works — your mail provider, Postmark, SendGrid, Amazon SES, Mailgun:

```sh
SMTP_HOST=smtp.example.com
SMTP_PORT=587            # 587: STARTTLS (default); 465: TLS
SMTP_USER=…
SMTP_PASSWORD=…
MAIL_FROM=GanttLines <plan@example.com>
```

Check it under Settings → Email → **Send me a test email**. Links in emails use `PUBLIC_URL`, so
set that to the address people actually open.

## Single sign-on (Google and others)

People can sign in with an OpenID Connect provider — Google, Microsoft Entra ID, Keycloak,
Authentik and others — next to (or instead of) passwords. For Google:

1. In Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID** of type
   *Web application*, with the authorized redirect URI `<PUBLIC_URL>/api/auth/oidc/callback`
   (e.g. `https://plan.example.com/api/auth/oidc/callback`).
2. In `.env`:

   ```sh
   OIDC_ISSUER=https://accounts.google.com
   OIDC_CLIENT_ID=…apps.googleusercontent.com
   OIDC_CLIENT_SECRET=…
   OIDC_NAME=Google
   OIDC_ALLOWED_DOMAINS=yourcompany.com   # optional: only these email domains
   ```

3. `docker compose up -d`. The sign-in page now shows **Sign in with Google**.

Who gets in: someone whose (verified) email matches an existing account signs into it — so the
usual way is to add people under Settings → Users first; their temporary password stops working
once they've used single sign-on. With `OIDC_AUTO_CREATE=true`, anyone the provider vouches for
(within `OIDC_ALLOWED_DOMAINS`) gets an account with `OIDC_DEFAULT_ROLE` (default `viewer`).

**The first admin on a fresh install** can sign in with the provider too: set `ADMIN_EMAIL` (no
password needed) and whoever first signs in with that email becomes the admin. Without
`ADMIN_EMAIL`, the first person to sign in from one of `OIDC_ALLOWED_DOMAINS` becomes the admin. With
neither, single sign-on waits until the admin is created with the setup code — otherwise anyone
the provider knows could claim the install.

## Two-factor sign-in

Anyone with a password can add a code from an authenticator app (Google Authenticator,
1Password, Authy …): Settings → Your account → **Turn on two-factor**. They get ten single-use
recovery codes for when they lose their phone; an admin can also turn it off for them (Settings →
Users). People signing in through single sign-on use their provider's two-factor instead.

Admins can require it for admins or for everyone (Settings → Two-factor sign-in). People it
covers set it up the next time they open GanttLines, before anything else, and can't turn it off.

The app secrets are stored encrypted with a key derived from `SESSION_SECRET` — changing that
secret means everyone with two-factor turns it on again (an admin can turn it off for them).

## AI access (MCP)

AI apps can read your plans through [MCP](https://modelcontextprotocol.io) as the person who
connects them. An admin turns it on under Settings → **AI access (MCP)** and chooses what apps may
be allowed to do (read plans, edit plans, comments, the team calendar). Then each person adds the
server address shown there — `https://your-server/mcp` — to their AI app:

- **Claude** (claude.ai or the desktop app): Settings → Connectors → Add custom connector.
- **Claude Code:** `claude mcp add --transport http ganttlines https://your-server/mcp`
- **ChatGPT:** Settings → Connectors (developer mode) → Create, with the address.
- **Cursor** and other apps: add an MCP server with the address (HTTP transport).

The app opens GanttLines to ask **Allow access?**: the person signs in if needed, sees what the app
asks for, and can give it less. Roles still apply (a viewer's app only reads), and what the app does
is checked like anything the person does. Everyone sees their connected apps under Settings → Your
account and can disconnect them; admins see everyone's. Turning AI access off refuses every app at
once (connections come back when it's turned on again).

What apps can do, by group: **read plans** (list projects, read a board with its computed dates,
find tasks across projects, recent changes); **edit plans** (create and rename projects; add, change,
move and delete tasks — several at once, following each other, assigned by name; undo the app's
last change); **comments** (read and add); **team calendar** (read, and — if allowed — change team
members, locations, holidays and time off, or add a country's public holidays). Changes appear live
on open boards and in the history as “Ana via Claude”; people can undo them like any other.

**Access tokens** are for apps (or scripts) that take a token instead of signing in: Settings →
Your account → **Create an access token**, choose what it may do and when it expires, and give the
app the address plus the header `Authorization: Bearer gl_pat_…`. For example, with Claude Code:
`claude mcp add --transport http ganttlines https://your-server/mcp --header "Authorization: Bearer gl_pat_…"`.
Tokens are listed (and disconnected) with the other apps, and follow the same rules.

AI apps never see users, settings or share links. The server must be reachable over HTTPS from the
AI app — for claude.ai and ChatGPT that means from the internet.

## Where the data lives

- **Database:** the `pgdata` volume (bundled database) or your own server.
- **Backups:** the `backups` volume, mounted at `/backups` in the app container.

`docker compose down` keeps both; `docker compose down -v` **deletes them**.

## Backups

```sh
docker compose exec app ganttlines backup           # → /backups/ganttlines-<time>.dump
docker compose cp app:/backups ./backups                # copy them to this machine
```

Backups are PostgreSQL custom-format dumps of the whole database. Schedule the first command
(e.g. with cron) for regular backups, and keep copies off the machine.

To keep backups in a folder on this machine instead of the volume, replace `backups:/backups` with
`./backups:/backups` in `docker-compose.yml` and make the folder writable by the container
(`mkdir backups && sudo chown 1000:1000 backups`).

### Restore

This replaces everything in the database with the backup:

```sh
docker compose stop app
docker compose run --rm --no-deps app restore /backups/ganttlines-<time>.dump
docker compose start app
```

To restore a file from this machine, copy it in first: `docker compose cp ./my.dump app:/backups/`.

## Upgrade

```sh
docker compose pull
docker compose up -d
```

Admins see under Settings → About (and as a dot on Settings) when a newer version is out: about
once a day the server asks GitHub for the latest release — nothing about your projects or people
is sent. Admins can switch this off there.

On start the app checks whether the new version changes the database. If it does, it **first
backs up** the database into `/backups` (`…-before-<version>.dump`), then migrates, then serves.
If the backup or the migration fails, the app does not start and the log says how to go back:
restore the pre-upgrade backup and run the previous version again (set `GP_TAG` to it).

Pin a version in `.env` with `GP_TAG` — a major version (`1`) follows its compatible updates, a
minor (`1.4`) only fixes, and an exact version (`1.4.0`) never changes. Release notes are on
<https://github.com/d-martins/ganttlines/releases>.

### Build from source

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Access from your network and HTTPS

Set `HOST_BIND=0.0.0.0` to accept connections from other machines. For anything beyond a trusted
network, put it behind a reverse proxy that terminates HTTPS (Caddy, nginx, Traefik), set
`PUBLIC_URL` to the `https://` address and `TRUST_PROXY=1`. The proxy must pass WebSocket
upgrades on `/ws`.

## Remove it completely

```sh
docker compose down -v   # stops it and deletes the database and backup volumes
```

## Development

Yarn 4 + Turborepo monorepo (TypeScript). `yarn install`, then from the repo root:

- `yarn test` — unit and integration tests (the server's use a throwaway PostgreSQL in Docker)
- `yarn type-check`
- `yarn e2e` — end-to-end tests in a real browser against the production build (needs Docker; the
  first time, install the browser with `yarn workspace @ganttlines/e2e playwright install chromium`)

### Releasing

Push a version tag, e.g. `git tag v0.2.0 && git push origin v0.2.0`. GitHub Actions runs the tests,
publishes the image (`0.2.0`, `0.2`, `latest`; from 1.0 also the major) for amd64 and arm64, and
creates the GitHub release with notes from the commits.

## License

MIT — see [LICENSE](LICENSE).
