//! The Grenier desktop viewer. For now an empty window with the theme; the screens come from
//! `ui`, and their data from the server once the viewer is wired to it.

use gpui_kit::{
    AppContext as _, Context, IntoElement, ParentElement as _, Render, Styled as _, Window,
    WindowOptions, div,
};
use ui::placeholder::Placeholder;

struct Viewer;

impl Render for Viewer {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(Placeholder::new(
            "Grenier",
            "The viewer is not connected yet.",
        ))
    }
}

fn main() {
    gpui_kit::application()
        .with_assets(ui::assets::Assets)
        .run(|cx| {
            gpui_kit::init(cx);
            gpui_kit::open_window(
                WindowOptions {
                    app_id: Some("grenier".into()),
                    ..WindowOptions::default()
                },
                cx,
                |_, cx| cx.new(|_| Viewer),
            )
            .expect("the window opens");
        });
}
