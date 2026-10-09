//! The theme of the viewer, defined once. Colours come from Hippocampe's theme, `theme.json`, which
//! GPUI Kit loads as its light and dark themes: every screen reads them from `cx.theme()`.
//! Spacing, the type scale, the widths and the fonts come from here, so no screen writes a literal
//! size or names a font.

use std::borrow::Cow;

use gpui_kit::component::{ActiveTheme as _, Theme, ThemeMode, ThemeRegistry};
use gpui_kit::{App, Hsla, Pixels, px};

const THEMES: &str = include_str!("theme.json");

/// The families of the viewer, shipped inside it (`apps/desktop/assets/fonts`), so it reads the
/// same on every machine.
pub mod font {
    /// The text: Open Sauce Sans.
    pub const TEXT: &str = "Open Sauce Sans";
    /// The headings: the titles of entries, the sections of a page, the headings of a body. Peace
    /// Sans has one weight, and every letter of French.
    pub const HEADING: &str = "Peace Sans";
}

/// The font files, read into the program when it is built.
pub const FONTS: [&[u8]; 6] = [
    include_bytes!("../../../assets/fonts/OpenSauceSans-Regular.ttf"),
    include_bytes!("../../../assets/fonts/OpenSauceSans-Italic.ttf"),
    include_bytes!("../../../assets/fonts/OpenSauceSans-Medium.ttf"),
    include_bytes!("../../../assets/fonts/OpenSauceSans-SemiBold.ttf"),
    include_bytes!("../../../assets/fonts/OpenSauceSans-Bold.ttf"),
    include_bytes!("../../../assets/fonts/PeaceSans-Regular.ttf"),
];

/// Gives the text system the viewer's fonts: once, at start-up, before the first window.
pub fn load_fonts(cx: &mut App) {
    cx.text_system()
        .add_fonts(FONTS.iter().map(|font| Cow::Borrowed(*font)).collect())
        .expect("the embedded fonts are valid");
}

/// Light or dark, for the whole application, in Hippocampe's colours.
pub fn set_dark(dark: bool, cx: &mut App) {
    ThemeRegistry::global_mut(cx)
        .load_themes_from_str(THEMES)
        .expect("theme.json is a valid theme set");
    let themes = ThemeRegistry::global(cx).themes();
    let light = themes["Hippocampe Light"].clone();
    let dark_theme = themes["Hippocampe Dark"].clone();
    let theme = Theme::global_mut(cx);
    theme.light_theme = light;
    theme.dark_theme = dark_theme;
    let mode = if dark {
        ThemeMode::Dark
    } else {
        ThemeMode::Light
    };
    Theme::change(mode, None, cx);
    Theme::global_mut(cx).font_family = font::TEXT.into();
}

/// Which theme the owner chose: the system's, or one of the two.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ThemeChoice {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemeChoice {
    /// Every choice, in the order the menu shows them.
    pub const ALL: [ThemeChoice; 3] = [ThemeChoice::System, ThemeChoice::Light, ThemeChoice::Dark];

    /// The name the configuration keeps it under.
    pub fn name(self) -> &'static str {
        match self {
            ThemeChoice::System => "system",
            ThemeChoice::Light => "light",
            ThemeChoice::Dark => "dark",
        }
    }

    /// The choice a name keeps; the system's for any other.
    pub fn from_name(name: &str) -> Self {
        Self::ALL
            .into_iter()
            .find(|choice| choice.name() == name)
            .unwrap_or_default()
    }

    /// Whether it shows the dark theme, the system being dark or not.
    pub fn is_dark(self, system_dark: bool) -> bool {
        match self {
            ThemeChoice::System => system_dark,
            ThemeChoice::Light => false,
            ThemeChoice::Dark => true,
        }
    }
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

    pub const XS: Pixels = px(11.);
    pub const SMALL: Pixels = px(12.);
    pub const BODY: Pixels = px(13.);
    /// The body of an entry, read at length.
    pub const PROSE: Pixels = px(15.);
    /// The summary under a title.
    pub const LEAD: Pixels = px(16.);
    /// A section of a page.
    pub const HEADING: Pixels = px(21.);
    /// A part of a section.
    pub const SUBHEADING: Pixels = px(17.);
    pub const TITLE: Pixels = px(28.);
}

/// The widths and heights of the layout.
pub mod width {
    use super::{Pixels, px};

    /// The column a page reads in: long lines are hard to follow.
    pub const READING: Pixels = px(720.);
    /// The sidebar of the tree.
    pub const SIDEBAR: Pixels = px(260.);
    /// How narrow, and how wide, the sidebar may be dragged.
    pub const SIDEBAR_MIN: Pixels = px(200.);
    pub const SIDEBAR_MAX: Pixels = px(560.);
    /// The column of contents beside a page.
    pub const CONTENTS: Pixels = px(220.);
    /// The labels of a list of fields.
    pub const LABEL: Pixels = px(180.);
    /// One row of the tree.
    pub const ROW: Pixels = px(30.);
    /// Below this width the contents of a page are left out, so the page keeps its room.
    pub const WITH_CONTENTS: Pixels = px(1180.);
    /// Below this width the sidebar folds away, until it is asked for.
    pub const WITH_SIDEBAR: Pixels = px(820.);
}
