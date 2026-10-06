//! The gallery of the viewer's screens: every screen in every state, with invented data, without
//! a server. A sidebar lists the stories, a switch toggles light and dark, and
//! `cargo run -p story -- --story <name>` opens one story directly, for a screenshot.

use gpui_kit::base::Selectable as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{ActiveTheme as _, Sizable as _};
use gpui_kit::{
    AnyElement, App, Context, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Window, div,
};
use ui::placeholder::Placeholder;
use ui::theme::{self, space, text};

/// One screen in one state.
pub struct Story {
    /// Its name, `screen/state`: what `--story` takes.
    pub name: &'static str,
    render: fn(&mut Window, &mut App) -> AnyElement,
}

/// Every story, in the order of the sidebar.
pub fn stories() -> Vec<Story> {
    vec![Story {
        name: "placeholder/normal",
        render: |_, _| {
            Placeholder::new("Grenier", "The screens of the viewer come here.").into_any_element()
        },
    }]
}

/// The gallery: the list of stories, the one shown, and light or dark.
pub struct Gallery {
    stories: Vec<Story>,
    shown: &'static str,
}

impl Gallery {
    /// The gallery, showing `shown` when it names a story, else the first one.
    pub fn new(shown: Option<&str>) -> Self {
        let stories = stories();
        let shown = shown
            .and_then(|name| stories.iter().find(|story| story.name == name))
            .or(stories.first())
            .map_or("", |story| story.name);
        Self { stories, shown }
    }

    /// The name of the story shown.
    pub fn shown(&self) -> &'static str {
        self.shown
    }

    /// Shows the story of that name.
    pub fn show(&mut self, name: &'static str, cx: &mut Context<Self>) {
        self.shown = name;
        cx.notify();
    }
}

impl Render for Gallery {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = theme::is_dark(cx);
        let story = self
            .stories
            .iter()
            .find(|story| story.name == self.shown)
            .map(|story| (story.render)(window, cx));
        let entries = self.stories.iter().map(|story| {
            let name = story.name;
            Button::new(SharedString::from(name))
                .ghost()
                .small()
                .selected(name == self.shown)
                .label(name)
                .on_click(cx.listener(move |gallery, _, _, cx| gallery.show(name, cx)))
        });
        div()
            .size_full()
            .flex()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(
                div()
                    .w(gpui_kit::px(240.))
                    .h_full()
                    .flex()
                    .flex_col()
                    .gap(space::XS)
                    .p(space::M)
                    .border_r_1()
                    .border_color(cx.theme().border)
                    .child(div().text_size(text::HEADING).child("Stories"))
                    .child(
                        Switch::new("dark")
                            .label("Dark")
                            .checked(dark)
                            .on_change(cx.listener(|_, dark: &bool, _, cx| {
                                theme::set_dark(*dark, cx);
                                cx.notify();
                            })),
                    )
                    .children(entries),
            )
            .child(div().flex_1().h_full().children(story))
    }
}
