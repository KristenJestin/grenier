# Grenier

A self-hosted personal knowledge system, written by AI agents through MCP and read by a person
in a small web interface. Nothing is typed in code: types and their fields are data.

Early development. See [`AGENTS.md`](AGENTS.md) for how the repository works and
[`docs/model.md`](docs/model.md) for the data model.

## The desktop viewer

Each release carries the viewer, built for Linux (`grenier-desktop-<version>-linux-x86_64.tar.gz`)
and Windows (`grenier-desktop-<version>-windows-x86_64.zip`), each with its `.sha256`. On Linux,
one script installs it and updates it from the latest release (it needs `curl`, `tar` and
`sha256sum`, and no GitHub account):

```
curl -fsSL https://raw.githubusercontent.com/KristenJestin/grenier/main/apps/desktop/scripts/update.sh | sh
```

It puts `grenier-desktop` in `~/.local/bin`, its launcher in `~/.local/share/applications` and its
icon beside it; `sh update.sh --check` only says whether a newer viewer exists. It never touches
`~/.config/grenier/`, where the viewer reads its server and its key (see
[`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md)). `grenier-desktop --version` prints the version.
On Windows, unpack the archive anywhere and run `grenier-desktop.exe`.
