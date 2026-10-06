//! The small parts every screen is made of, so the screens share one look: section headings,
//! clickable rows, and the column a page reads in.

use gpui_kit::component::list::ListItem;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, IntoElement, ParentElement as _,
    SharedString, Styled as _, Window, div,
};

use crate::theme::{space, text, width};

/// The column a page reads in, centred in the pane.
pub fn page(cx: &App) -> gpui_kit::Div {
    let _ = cx;
    v_flex()
        .w_full()
        .max_w(width::READING)
        .mx_auto()
        .px(space::XL)
        .pt(space::XL)
        .pb(px_from(64.))
        .gap(space::XL)
}

fn px_from(value: f32) -> gpui_kit::Pixels {
    gpui_kit::px(value)
}

/// A section of a page: its title, how many things it holds, and the things.
pub fn section(
    title: impl Into<SharedString>,
    count: Option<usize>,
    body: impl IntoElement,
    cx: &App,
) -> AnyElement {
    v_flex()
        .gap(space::S)
        .child(
            h_flex()
                .gap(space::S)
                .items_baseline()
                .child(
                    div()
                        .text_size(text::BODY)
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(title.into()),
                )
                .children(count.map(|count| {
                    div()
                        .text_size(text::SMALL)
                        .text_color(cx.theme().muted_foreground)
                        .child(count.to_string())
                })),
        )
        .child(body)
        .into_any_element()
}

/// A row that opens something: an icon, a title, and a quiet detail on the trailing edge.
pub fn row(
    id: impl Into<ElementId>,
    icon: impl Into<Icon>,
    title: impl Into<SharedString>,
    detail: Option<SharedString>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    ListItem::new(id)
        .py(space::XS)
        .px(space::S)
        .rounded(cx.theme().radius)
        .child(
            h_flex()
                .w_full()
                .gap(space::S)
                .child(
                    Icon::new(icon)
                        .small()
                        .text_color(cx.theme().muted_foreground),
                )
                .child(div().flex_1().min_w_0().truncate().child(title.into()))
                .children(detail.map(|detail| {
                    div()
                        .flex_none()
                        .text_size(text::SMALL)
                        .text_color(cx.theme().muted_foreground)
                        .child(detail)
                })),
        )
        .on_click(on_click)
        .into_any_element()
}

/// A list of rows, tight together.
pub fn rows(children: impl IntoIterator<Item = AnyElement>) -> AnyElement {
    v_flex()
        .gap(px_from(1.))
        .children(children)
        .into_any_element()
}
