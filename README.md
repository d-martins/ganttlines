# GanttLines

A self-hostable Gantt planner in the spirit of Instagantt: a task list and a timeline side by side,
live collaboration, dependencies that push dates, working-day calendars with holidays and time off,
baselines and share links. One app container plus PostgreSQL.

## Run it

You need Docker with Compose v2.20 or newer.

```sh
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD and SESSION_SECRET (e.g. openssl rand -hex 24 / openssl rand -hex 32)
docker compose up -d
```

Open <http://localhost:3000> and create the first (admin) account.

| Task | Command |
| --- | --- |
| Stop / start | `docker compose stop` · `docker compose start` |
| Logs | `docker compose logs -f app` |
| Version | `docker compose exec app ganttlines version` |

### Settings (`.env`)

| Variable | Meaning |
| --- | --- |
| `COMPOSE_PROFILES=bundled-db` | Run the bundled PostgreSQL. Remove it to use your own database. |
| `POSTGRES_PASSWORD` | Password of the bundled database (letters and digits). |
| `DATABASE_URL` | Your own PostgreSQL instead, e.g. `postgresql://user:pass@host:5432/ganttlines?sslmode=require`. |
| `SESSION_SECRET` | Required, 32+ characters. Changing it signs everyone out. |
| `PUBLIC_URL` | The address people open, e.g. `https://plan.example.com`. |
| `HOST_BIND`, `HOST_PORT` | Where it listens on this machine (default `127.0.0.1:3000`, this computer only). |
| `TRUST_PROXY` | Behind a reverse proxy: how many proxies to trust (e.g. `1`). |
| `BACKUP_BEFORE_MIGRATE` | `true` (default): back up automatically before upgrading the database. |

### Your own PostgreSQL

Delete the `COMPOSE_PROFILES` line, set `DATABASE_URL` and start as usual; only the app container
runs. Use PostgreSQL 13 or newer and an empty database the user owns. A database on this same
machine is reachable from the container as `host.docker.internal`.

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
docker compose pull      # or: docker compose build, when building from source
docker compose up -d
```

On start the app checks whether the new version changes the database. If it does, it **first
backs up** the database into `/backups` (`…-before-<version>.dump`), then migrates, then serves.
If the backup or the migration fails, the app does not start and the log says how to go back:
restore the pre-upgrade backup and run the previous version again (set `GP_TAG` to it).

Pin a version in `.env` with `GP_TAG` — a major version (`1`) follows its compatible updates; an
exact version (`1.4.0`) never changes.

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
`yarn test`, `yarn type-check`. See `CLAUDE.md` and `docs/superpowers/`.

## License

MIT — see [LICENSE](LICENSE).
