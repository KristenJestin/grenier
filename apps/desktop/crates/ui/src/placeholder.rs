//! A screen that says what will be there: the first story of the gallery.

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::{
    App, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _, Window, div,
};

use crate::theme::{space, text};

/// A centred title and a line of explanation.
#[derive(IntoElement)]
pub struct Placeholder {
    title: SharedString,
    detail: SharedString,
}

impl Placeholder {
    pub fn new(title: impl Into<SharedString>, detail: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            detail: detail.into(),
        }
    }
}

impl RenderOnce for Placeholder {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(space::S)
            .bg(cx.theme().background)
            .child(
                div()
                    .text_size(text::TITLE)
                    .text_color(cx.theme().foreground)
                    .child(self.title),
            )
            .child(
                div()
                    .text_size(text::BODY)
                    .text_color(cx.theme().muted_foreground)
                    .child(self.detail),
            )
    }
}
