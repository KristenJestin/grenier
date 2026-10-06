//! The theme of the viewer, defined once. Colours come from Grenier's theme, `theme.json`, which
//! GPUI Kit loads as its light and dark themes: every screen reads them from `cx.theme()`.
//! Spacing, the type scale and the widths come from here, so no screen writes a literal size.

use gpui_kit::component::{ActiveTheme as _, Theme, ThemeMode, ThemeRegistry};
use gpui_kit::{App, Hsla, Pixels, px};

const THEMES: &str = include_str!("theme.json");

/// Light or dark, for the whole application, in Grenier's colours.
pub fn set_dark(dark: bool, cx: &mut App) {
    ThemeRegistry::global_mut(cx)
        .load_themes_from_str(THEMES)
        .expect("theme.json is a valid theme set");
    let themes = ThemeRegistry::global(cx).themes();
    let light = themes["Grenier Light"].clone();
    let dark_theme = themes["Grenier Dark"].clone();
    let theme = Theme::global_mut(cx);
    theme.light_theme = light;
    theme.dark_theme = dark_theme;
    let mode = if dark {
        ThemeMode::Dark
    } else {
        ThemeMode::Light
    };
    Theme::change(mode, None, cx);
}

/// Whether the application shows the dark theme.
pub fn is_dark(cx: &App) -> bool {
    Theme::global(cx).mode.is_dark()
}

/// Text that matters least: counts, hints, the trailing detail of a card.
pub fn faint(cx: &App) -> Hsla {
    cx.theme().muted_foreground.opacity(0.72)
}

/// The tint behind what the accent marks: the open entry, a chosen filter, a choice.
pub fn accent_tint(cx: &App) -> Hsla {
    cx.theme().list_active
}

/// The spaces between elements, smallest first.
pub mod space {
    use super::{Pixels, px};

    pub const XS: Pixels = px(4.);
    pub const S: Pixels = px(8.);
    pub const M: Pixels = px(12.);
    pub const L: Pixels = px(16.);
    pub const XL: Pixels = px(24.);
    pub const XXL: Pixels = px(32.);
    pub const XXXL: Pixels = px(48.);
}

/// The sizes of text, smallest first.
pub mod text {
    use super::{Pixels, px};

    pub const XS: Pixels = px(12.);
    pub const SMALL: Pixels = px(13.);
    pub const BODY: Pixels = px(14.);
    /// The body of an entry, read at length.
    pub const PROSE: Pixels = px(16.);
    /// The summary under a title.
    pub const LEAD: Pixels = px(18.);
    /// A section of a page.
    pub const HEADING: Pixels = px(24.);
    pub const TITLE: Pixels = px(34.);
}

/// The widths and heights of the layout.
pub mod width {
    use super::{Pixels, px};

    /// The column a page reads in: long lines are hard to follow.
    pub const READING: Pixels = px(720.);
    /// The sidebar of the tree.
    pub const SIDEBAR: Pixels = px(260.);
    /// The column of contents beside a page.
    pub const CONTENTS: Pixels = px(220.);
    /// The labels of a list of fields.
    pub const LABEL: Pixels = px(180.);
    /// One row of the tree.
    pub const ROW: Pixels = px(32.);
}
