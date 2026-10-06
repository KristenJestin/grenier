//! The theme of the viewer, defined once: colours come from GPUI Kit's theme (light or dark),
//! spacing and the type scale from here, so no screen writes a literal size.

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, Pixels, px};

/// Light or dark, for the whole application.
pub fn set_dark(dark: bool, cx: &mut App) {
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

/// The spaces between elements, smallest first.
pub mod space {
    use super::{Pixels, px};

    pub const XS: Pixels = px(4.);
    pub const S: Pixels = px(8.);
    pub const M: Pixels = px(12.);
    pub const L: Pixels = px(16.);
    pub const XL: Pixels = px(24.);
}

/// The sizes of text, smallest first.
pub mod text {
    use super::{Pixels, px};

    pub const SMALL: Pixels = px(12.);
    pub const BODY: Pixels = px(14.);
    pub const LEAD: Pixels = px(16.);
    pub const HEADING: Pixels = px(18.);
    pub const TITLE: Pixels = px(28.);
}

/// The widths of the layout.
pub mod width {
    use super::{Pixels, px};

    /// The column a page reads in: long lines are hard to follow.
    pub const READING: Pixels = px(760.);
    /// The sidebar of the tree.
    pub const SIDEBAR: Pixels = px(288.);
    /// The labels of a list of fields.
    pub const LABEL: Pixels = px(176.);
    /// The search field.
    pub const SEARCH: Pixels = px(520.);
}
