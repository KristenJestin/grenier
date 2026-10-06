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
  GPUI Kit's default set is added to `ui::assets`, or it draws nothing.
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

## Screenshots of a story

On Hyprland, capture only the story's window, never the whole screen: open the story, find its
window by the process id in `hyprctl clients -j`, and give its geometry to `grim -g "x,y wxh"`.
On Windows, open the story and capture the window with the Snipping Tool (window mode,
`Win+Shift+S`) or `Alt+PrtScn`. Screenshots are reviewed outside the repository; commit none
unless a document needs it.
