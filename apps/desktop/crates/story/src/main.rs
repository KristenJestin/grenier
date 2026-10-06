//! `cargo run -p story [-- --story <name>] [--dark]`: the gallery of the viewer's screens.

use gpui_kit::{AppContext as _, WindowOptions};
use story::Gallery;

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let story = arguments
        .iter()
        .position(|argument| argument == "--story")
        .and_then(|index| arguments.get(index + 1))
        .cloned();
    let dark = arguments.iter().any(|argument| argument == "--dark");
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            ui::theme::set_dark(dark, cx);
            gpui_kit::open_window(WindowOptions::default(), cx, |_, cx| {
                cx.new(|_| Gallery::new(story.as_deref()))
            })
            .expect("the gallery window opens");
        });
}
