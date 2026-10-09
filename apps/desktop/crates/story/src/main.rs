//! `cargo run -p story [-- --story <name>] [--dark]`: the gallery of the viewer's screens;
//! `--list` prints the names of the stories and opens nothing. Errors are logged on standard
//! error, and more with `RUST_LOG`.

use gpui_kit::{AppContext as _, WindowOptions};
use story::Gallery;

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.iter().any(|argument| argument == "--list") {
        for story in story::stories() {
            println!("{}", story.name);
        }
        return;
    }
    let story = arguments
        .iter()
        .position(|argument| argument == "--story")
        .and_then(|index| arguments.get(index + 1))
        .cloned();
    let dark = arguments.iter().any(|argument| argument == "--dark");
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("error")).init();
    gpui_kit::application()
        .with_assets(ui::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            ui::theme::load_fonts(cx);
            ui::viewer::init(cx);
            ui::theme::set_dark(dark, cx);
            gpui_kit::open_window(
                WindowOptions {
                    app_id: Some("hippocampe-story".into()),
                    ..WindowOptions::default()
                },
                cx,
                |window, cx| cx.new(|cx| Gallery::new(story.as_deref(), window, cx)),
            )
            .expect("the gallery window opens");
        });
}
