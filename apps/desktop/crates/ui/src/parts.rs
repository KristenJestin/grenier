//! The small parts every screen is made of, so the screens share one look: the column a page reads
//! in, its title, section headings, chips, and the cards that open what an entry is tied to.

use std::time::Duration;

use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, BoxShadow, ClickEvent, Div, ElementId, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, ParentElement as _, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, point, px, relative,
};

use gpui_kit::prelude::FluentBuilder as _;

use crate::motion::{enter, hoverable};
use crate::theme::{self, space, text, width};

/// The column a page reads in.
pub fn page() -> Div {
    v_flex().w_full().max_w(width::READING).min_w_0()
}

/// A page in its pane: it scrolls under `scroll`, centred, and comes in again each time `shown`
/// changes. The contents of the page, when given, sit beside it and stay put.
pub fn layout(
    scroll: &ScrollHandle,
    shown: usize,
    page: impl IntoElement,
    contents: Option<AnyElement>,
) -> Div {
    h_flex()
        .size_full()
        .min_h_0()
        .items_start()
        .child(
            div()
                .id("page")
                .flex_1()
                .min_w_0()
                .h_full()
                .overflow_y_scroll()
                .track_scroll(scroll)
                .vertical_scrollbar(scroll)
                // The contents follow the reading: they are drawn again as the page scrolls.
                .on_scroll_wheel(|_, window, _| window.refresh())
                .child(
                    h_flex()
                        .justify_center()
                        .pt(space::M)
                        .px(space::XXL)
                        .pb(px(80.))
                        .child(div().w_full().max_w(width::READING).child(enter(
                            ElementId::named_usize("page", shown),
                            Duration::ZERO,
                            page,
                        ))),
                ),
        )
        .children(contents.map(|contents| {
            div().h_full().pr(space::XXL).child(enter(
                ElementId::named_usize("contents", shown),
                Duration::from_millis(60),
                contents,
            ))
        }))
}

/// The title of a page.
pub fn title(title: impl Into<SharedString>) -> Div {
    div()
        .mt(space::M)
        .text_size(text::TITLE)
        .line_height(relative(1.15))
        .font_weight(FontWeight::BOLD)
        .child(title.into())
}

/// The sentence under a title.
pub fn lead(sentence: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .mt(space::M)
        .text_size(text::LEAD)
        .text_color(cx.theme().muted_foreground)
        .child(sentence.into())
}

/// The heading of a section of a page, with how many things it holds.
pub fn heading(title: impl Into<SharedString>, count: Option<usize>, cx: &App) -> Div {
    h_flex()
        .mt(space::XXXL)
        .mb(space::L)
        .gap(space::S)
        .items_baseline()
        .child(
            div()
                .text_size(text::HEADING)
                .font_weight(FontWeight::BOLD)
                .child(title.into()),
        )
        .children(count.map(|count| {
            div()
                .text_size(text::BODY)
                .text_color(theme::faint(cx))
                .child(count.to_string())
        }))
}

/// A small framed label: the type of an entry, a tag.
pub fn chip(icon: Option<Icon>, label: impl Into<SharedString>, cx: &App) -> Div {
    let theme = cx.theme();
    h_flex()
        .h(px(28.))
        .px(px(10.))
        .gap(px(6.))
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .bg(theme.secondary)
        .text_size(text::SMALL)
        .children(icon.map(|icon| icon.xsmall().text_color(theme.muted_foreground)))
        .child(label.into())
}

/// A chip that warns: what still waits for the owner.
pub fn warning_chip(icon: Icon, label: impl Into<SharedString>, cx: &App) -> Div {
    let warning = cx.theme().warning;
    chip(Some(icon.text_color(warning)), label, cx)
        .border_color(warning.opacity(0.))
        .bg(warning.opacity(0.1))
        .text_color(warning)
}

/// An icon in a small framed square, as cards and results lead with.
pub fn icon_box(icon: impl Into<Icon>, size: gpui_kit::Pixels, cx: &App) -> Div {
    let theme = cx.theme();
    div()
        .size(size)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .bg(theme.background)
        .child(Icon::new(icon).small().text_color(theme.muted_foreground))
}

/// What a card says: its icon, its title, a sentence, and how it relates to the page.
pub struct Card {
    pub icon: Icon,
    pub title: SharedString,
    pub detail: Option<SharedString>,
    pub relation: Option<SharedString>,
}

fn card_body(card: Card, cx: &App) -> Div {
    v_flex()
        .gap(px(6.))
        .child(div().mb(space::S).child(icon_box(card.icon, px(32.), cx)))
        .child(div().font_weight(FontWeight::MEDIUM).child(card.title))
        .children(card.detail.map(|detail| {
            div()
                .text_size(text::BODY)
                .text_color(cx.theme().muted_foreground)
                .child(detail)
        }))
        .children(card.relation.map(|relation| {
            div()
                .text_size(text::XS)
                .text_color(theme::faint(cx))
                .child(relation)
        }))
}

/// A card that opens something. Under the pointer it lifts a little, and its frame and shadow
/// take the accent.
pub fn card(
    id: impl Into<ElementId>,
    card: Card,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = cx.theme();
    let (idle, over, border, accent, radius) = (
        theme.secondary,
        theme.accent,
        theme.border,
        theme.primary,
        theme.radius_lg,
    );
    let body = card_body(card, cx);
    hoverable(id, window, cx, move |element, hover| {
        element
            .relative()
            .top(px(-2.) * hover.0)
            .p(space::L)
            .rounded(radius)
            .border_1()
            .border_color(hover.interpolate::<Hsla>(border, mix(border, accent, 0.35)))
            .bg(hover.interpolate::<Hsla>(idle, over))
            .shadow(vec![BoxShadow {
                color: accent.opacity(0.35 * hover.0),
                offset: point(px(0.), px(6.)),
                blur_radius: px(20.),
                spread_radius: px(-12.),
                inset: false,
            }])
            .cursor_pointer()
            .on_click(on_click)
            .child(body)
    })
}

/// A card that opens nothing, still under the pointer; dashed, for what this key may not see.
pub fn plain_card(card: Card, dashed: bool, cx: &App) -> Div {
    let theme = cx.theme();
    div()
        .p(space::L)
        .rounded(theme.radius_lg)
        .border_1()
        .when(dashed, |card| card.border_dashed())
        .when(!dashed, |card| card.bg(theme.secondary))
        .border_color(theme.border)
        .child(card_body(card, cx))
}

/// Cards, two by row.
pub fn cards(children: impl IntoIterator<Item = AnyElement>) -> Div {
    div().grid().grid_cols(2).gap(space::M).children(children)
}

/// `share` of the way from `from` to `to`.
pub fn mix(from: Hsla, to: Hsla, share: f32) -> Hsla {
    gpui_kit::AnimationPhase(share).interpolate(from, to)
}
