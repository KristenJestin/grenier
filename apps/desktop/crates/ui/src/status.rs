//! How a screen says it is waiting, has nothing, or could not get its data. One treatment for
//! every screen, so the states read the same everywhere.

use gpui_kit::assets::IconName;
use gpui_kit::component::skeleton::Skeleton;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, Div, ElementId, FontWeight, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px, relative,
};

use crate::intent::{Intent, OnIntent};
use crate::load::Problem;
use crate::motion::hoverable;
use crate::parts::mix;
use crate::text as words;
use crate::theme::{space, text};

/// Placeholder lines while data loads, shaped like what comes: a title, then text.
pub fn loading(lines: usize) -> Div {
    v_flex()
        .gap(space::M)
        .pt(space::XL)
        .child(Skeleton::new().h(px(28.)).w(relative(0.5)).mb(space::S))
        .children((0..lines).map(|line| {
            // Uneven widths read as text rather than as a table.
            let width = [0.92, 0.8, 0.86, 0.6, 0.9, 0.74][line % 6];
            Skeleton::new().h(px(12.)).w(relative(width))
        }))
}

/// A state: an icon in a square, a short title and what to do next.
fn state(icon: IconName, title: SharedString, detail: SharedString, danger: bool, cx: &App) -> Div {
    let theme = cx.theme();
    let (fg, bg, border) = if danger {
        (
            theme.danger,
            theme.danger.opacity(0.1),
            theme.danger.opacity(0.),
        )
    } else {
        (theme.muted_foreground, theme.secondary, theme.border)
    };
    v_flex()
        .w_full()
        .min_h(px(420.))
        .items_center()
        .justify_center()
        .gap(space::S)
        .p(space::XXL)
        .child(
            div()
                .mb(space::S)
                .size(px(48.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(theme.radius_lg)
                .border_1()
                .border_color(border)
                .bg(bg)
                .child(Icon::new(icon).text_color(fg)),
        )
        .child(
            div()
                .text_size(text::LEAD)
                .font_weight(FontWeight::SEMIBOLD)
                .child(title),
        )
        .child(
            div()
                .max_w(px(380.))
                .text_center()
                .text_color(theme.muted_foreground)
                .child(detail),
        )
}

/// What a screen shows when there is nothing.
pub fn empty(
    icon: IconName,
    title: impl Into<SharedString>,
    detail: impl Into<SharedString>,
    cx: &App,
) -> Div {
    state(icon, title.into(), detail.into(), false, cx)
}

/// The problem that kept the data away, what to do about it, and a way to try again.
pub fn failed(
    id: impl Into<ElementId>,
    problem: &Problem,
    on_intent: OnIntent,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let (title, message): (SharedString, SharedString) = match problem {
        Problem::Unreachable => (words::UNREACHABLE.into(), words::UNREACHABLE_DETAIL.into()),
        Problem::KeyRefused(sentence) => (words::KEY_REFUSED.into(), sentence.clone()),
        Problem::Refused(sentence) => (words::SERVER_REFUSED.into(), sentence.clone()),
        Problem::Unconfigured(sentence) => (words::UNCONFIGURED.into(), sentence.clone()),
    };
    let theme = cx.theme();
    let (idle, over, border, muted) = (
        theme.secondary,
        theme.accent,
        theme.border,
        theme.muted_foreground,
    );
    let foreground = theme.foreground;
    let retry = hoverable(id, window, cx, move |element, hover| {
        element
            .mt(space::M)
            .h(px(30.))
            .px(space::M)
            .flex()
            .items_center()
            .gap(px(6.))
            .rounded(px(8.))
            .border_1()
            .border_color(border)
            .bg(mix(idle, over, hover.0))
            .text_size(text::SMALL)
            .text_color(mix(muted, foreground, hover.0))
            .cursor_pointer()
            .on_click(move |_, window, cx| on_intent(Intent::Retry, window, cx))
            .child(Icon::new(IconName::RefreshCw).xsmall())
            .child(words::RETRY)
    });
    state(IconName::TriangleAlert, title, message, true, cx)
        .child(h_flex().child(retry))
        .into_any_element()
}

/// A short state for the sidebar, where there is little room.
pub fn side_note(
    icon: IconName,
    title: impl Into<SharedString>,
    detail: impl Into<SharedString>,
    danger: bool,
    cx: &App,
) -> Div {
    let theme = cx.theme();
    let fg = if danger {
        theme.danger
    } else {
        theme.muted_foreground
    };
    v_flex()
        .items_center()
        .gap(space::XS)
        .px(space::M)
        .py(space::XL)
        .text_center()
        .child(Icon::new(icon).text_color(fg).mb(space::S))
        .child(div().font_weight(FontWeight::SEMIBOLD).child(title.into()))
        .child(
            div()
                .text_size(text::SMALL)
                .text_color(theme.muted_foreground)
                .child(detail.into()),
        )
}
