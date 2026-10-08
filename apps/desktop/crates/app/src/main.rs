//! The Grenier desktop viewer: `cargo run -p app`, pointed at a server by its configuration
//! (see `app::config`); `--version` prints its version. Errors are logged on standard error,
//! and more with `RUST_LOG` (`RUST_LOG=debug`).

// A release build on Windows opens no console beside its window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use app::shell::Shell;
use gpui_kit::{AppContext as _, WindowAppearance, WindowOptions};
use ui::theme::ThemeChoice;

fn main() {
    if std::env::args()
        .skip(1)
        .any(|argument| argument == "--version")
    {
        println!("grenier-desktop {}", app::VERSION);
        return;
    }
    // Errors only unless `RUST_LOG` asks for more: GPUI ends its event loop on a fatal error by
    // logging it and returning, so without a logger a failure at start says nothing.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("error")).init();
    gpui_kit::application()
        .with_assets(ui::assets::Assets)
        .run(|cx| {
            gpui_kit::init(cx);
            ui::theme::load_fonts(cx);
            ui::viewer::init(cx);
            let preferences = app::config::preferences();
            let choice = ThemeChoice::from_name(preferences.theme.as_deref().unwrap_or(""));
            let system_dark = matches!(
                cx.window_appearance(),
                WindowAppearance::Dark | WindowAppearance::VibrantDark
            );
            ui::theme::set_dark(choice.is_dark(system_dark), cx);
            gpui_kit::open_window(
                WindowOptions {
                    app_id: Some("grenier".into()),
                    ..WindowOptions::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| Shell::new(app::config::client(), &preferences, window, cx))
                },
            )
            .expect("the window opens");
        });
}
