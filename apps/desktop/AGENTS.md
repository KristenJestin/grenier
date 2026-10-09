# AGENTS.md — the desktop viewer

Read the root `AGENTS.md` first; this file adds the rules of `apps/desktop`, a Cargo workspace in
Rust with GPUI Kit (`gpui-kit`, pinned exactly in `Cargo.toml`; Rust pinned in
`rust-toolchain.toml`). Before writing GPUI code, read GPUI Kit's Coding Guides and Design Guides
(`https://gpui-kit.com/docs/coding-guides.md`, `design-guides.md`): never invent an API, search
the crate's source for the real signature.

## Crates

- `crates/api`: the types the read API exchanges, **generated** from
  `packages/api/openapi.json` by `crates/api-gen` (`bun run generate` at the root). Never edit
  `types.rs` by hand; a test fails when it is stale.
- `crates/ui`: the screens and components. **A screen never calls the network**: it receives
  plain data and a state (loading, empty, error, ready) and emits what the user asks for (open an
  entry, search, follow a link). Colours come from the theme (`cx.theme()`), which Grenier's
  `crates/ui/src/theme.json` fills, light and dark; spacing and text sizes from `ui::theme`; how
  things move from `ui::motion`: no literal colour, size or duration in a screen. An icon outside
  GPUI Kit's default set is added to `ui::assets`, or it draws nothing. The fonts ship inside the
  viewer (`assets/fonts`, with their licences and origin in its `README.md`), loaded by
  `ui::theme::load_fonts` before the first window; a screen names a family only through
  `ui::theme::font` (`TEXT`, `HEADING`). A screen names its words only through `ui::text`, in
  English (headings, buttons, states, messages, dates in words); a test fails on a sentence
  written anywhere else. What comes from the server (titles, bodies, the labels of types and
  fields, the sentences of a refusal) is shown as it was written.
- `crates/story`: the gallery, the place to design a screen. One story per screen and state,
  named `screen/state`, with invented data only (never a real person, address or amount).
- `crates/app`: the application binary.

## Commands

From `apps/desktop` (or through Turborepo from the root: `bun run check` runs fmt, clippy and
the tests):

```
cargo run -p story                          # the gallery
cargo run -p story -- --story <name> --dark # one story, directly, in dark
cargo run -p app                            # the application
cargo test --workspace                      # with GPUI Kit's headless tests
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
```

## Releases and updates

A release of Grenier builds the viewer from its tag (`.github/workflows/release.yml`), its version
taken from the tag (`HIPPOCAMPE_VERSION` at build time, `unknown` in a local build; shown at the foot
of the sidebar and by `grenier-desktop --version`), packs it with `scripts/package.sh` and attaches
the archives and their checksums to the release. `scripts/update.sh` installs or updates it on
Linux from the latest release; its tests (`crates/app/tests/update_script.rs`) run it against a
local fake release server. The launcher and the icon of an archive are in `assets/release/` (the
icon is provisional).

The dispatch of `release.yml` (`workflow_dispatch`) is a dry run of the viewer's build: it builds
the tag it is given and attaches the archives to that tag's release, and tags nothing. A tag
cut before the viewer was released (such as `v0.4.0`) has no `scripts/package.sh` and no
`grenier-desktop` target, and the job makes no release, so a dry run needs a tag and a release of
its own, on the branch under test:

```
git tag v0.0.0-dry-run.1 <branch> && git push origin v0.0.0-dry-run.1
gh release create v0.0.0-dry-run.1 --prerelease --title "dry run" --notes "Deleted after the run."
gh workflow run release.yml --ref <branch> -f tag=v0.0.0-dry-run.1
gh run watch                                    # then check both archives on the release
gh release delete v0.0.0-dry-run.1 --yes --cleanup-tag
git tag -d v0.0.0-dry-run.1
```

The release is a pre-release, so `releases/latest`, which `update.sh` reads, never points at it;
`--cleanup-tag` deletes the tag on GitHub with it.

## When the viewer fails at start

The viewer and the gallery print the errors GPUI logs on standard error; `RUST_LOG` shows more.
To report a failure at start (a window that never opens, a viewer that quits at once), run it from
a terminal and keep everything it prints:

```
RUST_LOG=debug WAYLAND_DEBUG=1 grenier-desktop 2> grenier-desktop.log; echo "exit $?"
```

`WAYLAND_DEBUG=1` adds the exchange with the Wayland compositor; leave it out on X11. Give the
log, the exit code, the desktop (compositor, scale) and the graphics card with the report. On
Windows, a release build has no console: in PowerShell, `$env:RUST_LOG="debug"`, then
`Start-Process .\grenier-desktop.exe -Wait -RedirectStandardError grenier-desktop.log`.

## Pointing the viewer at a server

The application reads `grenier/desktop.json` in the system's configuration folder
(`~/.config/grenier/desktop.json` on Linux, `%APPDATA%\grenier\desktop.json` on Windows), or
the file `HIPPOCAMPE_DESKTOP_CONFIG` names:

```json
{ "server": "http://127.0.0.1:3000", "key_file": "~/.config/grenier/key" }
```

`key_file` holds a key with the right `read` (`key:create --rights read`), alone on its line;
give it to no one else (`chmod 600`). The key is read from that file at start and sent as
`Authorization: Bearer`; it is never written in the configuration, nor printed, nor logged. A
key without `sensitive` sees sensitive values as hidden. Without a configuration, the viewer says
what to create.

## Screenshots of a story

On Hyprland, capture only the story's window, never the whole screen: open the story, find its
window by the process id in `hyprctl clients -j`, and give its geometry to `grim -g "x,y wxh"`.
On Windows, open the story and capture the window with the Snipping Tool (window mode,
`Win+Shift+S`) or `Alt+PrtScn`. Screenshots are reviewed outside the repository; commit none
unless a document needs it.
