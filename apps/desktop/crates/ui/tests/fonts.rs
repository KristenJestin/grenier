//! The viewer's fonts ship inside it: the text in Open Sauce Sans, the headings in Peace Sans.
//! Read by the text system of the platform, headless: the one of the tests knows no font.

use std::borrow::Cow;

use ui::theme::{FONTS, font};

#[test]
fn the_headings_are_in_peace_sans_and_the_text_in_open_sauce_sans() {
    let text = gpui_kit::platform::current_platform(true).text_system();
    text.add_fonts(FONTS.iter().map(|bytes| Cow::Borrowed(*bytes)).collect())
        .expect("the embedded fonts are valid");
    let names = text.all_font_names();
    assert_eq!(font::TEXT, "Open Sauce Sans");
    assert_eq!(font::HEADING, "Peace Sans");
    for family in [font::TEXT, font::HEADING] {
        assert!(
            names.iter().any(|name| name == family),
            "{family} is embedded"
        );
    }
}
