# Hippocampe

A self-hosted personal knowledge system, written by AI agents through MCP and read by a person
in a small web interface. Nothing is typed in code: types and their fields are data.

Free software under the [AGPL-3.0](LICENSE). Early development. See [`AGENTS.md`](AGENTS.md) for how the repository works and
[`docs/model.md`](docs/model.md) for the data model. The desktop viewer embeds two fonts under
the SIL Open Font License 1.1, Open Sauce Sans and Peace Sans: see
[`apps/desktop/assets/fonts`](apps/desktop/assets/fonts/README.md).

## Hippocampe on one machine

`npm i -g @netsirk/hippocampe`, then `hippo service install`: Hippocampe runs as a service of your
session on Linux, with a database of its own, on `127.0.0.1` only. Install, update, uninstall and
where the data is: [`docs/install.md`](docs/install.md). `hippo --help` lists every command.
What a version promises: [`docs/versions.md`](docs/versions.md).

## Hippocampe with Docker

Server and database in one `docker compose up -d`, on a machine or on a server: start, configure,
save, update, in [`docs/docker.md`](docs/docker.md). (`docs/install.md` is the npm package as a
service; it is not the page of a Docker installation.)

## The desktop viewer

Each release carries the viewer, built for Linux (`hippocampe-desktop-<version>-linux-x86_64.tar.gz`)
and Windows (`hippocampe-desktop-<version>-windows-x86_64.zip`), each with its `.sha256`. On Linux,
one script installs it and updates it from the latest release (it needs `curl`, `tar` and
`sha256sum`, and no GitHub account):

```
curl -fsSL https://raw.githubusercontent.com/KristenJestin/hippocampe/main/apps/desktop/scripts/update.sh | sh
```

It puts `hippocampe-desktop` in `~/.local/bin`, its launcher in `~/.local/share/applications` and its
icon beside it; `sh update.sh --check` only says whether a newer viewer exists. It never touches
`~/.config/hippocampe/`, where the viewer reads its server and its key (see
[`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md)). `hippocampe-desktop --version` prints the version.
Between a release and the end of its builds, or when a build failed, the latest release has no
archive yet: the script says so and changes nothing; run it again later. A viewer that says a
version newer than the latest release, such as a local build (`9.9.9-local`), is never replaced.
On Windows, unpack the archive anywhere and run `hippocampe-desktop.exe`.
