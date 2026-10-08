//! The Grenier desktop viewer: `cargo run -p app`, pointed at a server by its configuration
//! (see `app::config`); `--version` prints its version.

use app::shell::Shell;
use gpui_kit::{AppContext as _, WindowAppearance, WindowOptions};

fn main() {
    if std::env::args()
        .skip(1)
        .any(|argument| argument == "--version")
    {
        println!("grenier-desktop {}", app::VERSION);
        return;
    }
    gpui_kit::application()
        .with_assets(ui::assets::Assets)
        .run(|cx| {
            gpui_kit::init(cx);
            ui::theme::load_fonts(cx);
            ui::viewer::init(cx);
            let dark = matches!(
                cx.window_appearance(),
                WindowAppearance::Dark | WindowAppearance::VibrantDark
            );
            ui::theme::set_dark(dark, cx);
            gpui_kit::open_window(
                WindowOptions {
                    app_id: Some("grenier".into()),
                    ..WindowOptions::default()
                },
                cx,
                |window, cx| cx.new(|cx| Shell::new(app::config::client(), window, cx)),
            )
            .expect("the window opens");
        });
}
