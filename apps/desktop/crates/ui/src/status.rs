//! How a screen says it is waiting, has nothing, or could not get its data. One treatment for
//! every screen, so the states read the same everywhere.

use gpui_kit::component::alert::Alert;
use gpui_kit::component::button::Button;
use gpui_kit::component::skeleton::Skeleton;
use gpui_kit::component::{ActiveTheme as _, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    App, ElementId, IntoElement, ParentElement as _, SharedString, Styled as _, div, relative,
};

use crate::intent::{Intent, OnIntent};
use crate::load::Problem;
use crate::theme::{space, text};

/// Placeholder lines while data loads, shaped like what comes.
pub fn loading(lines: usize) -> impl IntoElement {
    v_flex()
        .gap(space::S)
        .p(space::L)
        .children((0..lines).map(|line| {
            // Uneven widths read as text rather than as a table.
            let width = [0.9, 0.7, 0.8, 0.55][line % 4];
            Skeleton::new().h(text::BODY).w(relative(width))
        }))
}

/// What a screen shows when there is nothing: a short title and the next action.
pub fn empty(
    title: impl Into<SharedString>,
    detail: impl Into<SharedString>,
    cx: &App,
) -> impl IntoElement {
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap(space::XS)
        .p(space::XL)
        .child(div().text_size(text::HEADING).child(title.into()))
        .child(
            div()
                .text_size(text::BODY)
                .text_color(cx.theme().muted_foreground)
                .child(detail.into()),
        )
}

/// The problem that kept the data away, what to do about it, and a way to try again.
pub fn failed(
    id: impl Into<ElementId>,
    problem: &Problem,
    on_intent: OnIntent,
) -> impl IntoElement {
    let (title, message): (SharedString, SharedString) = match problem {
        Problem::Unreachable => (
            "Le serveur ne répond pas".into(),
            "Vérifiez que Grenier tourne et que cet ordinateur l'atteint, puis réessayez.".into(),
        ),
        Problem::KeyRefused(sentence) => ("La clé a été refusée".into(), sentence.clone()),
    };
    let id = id.into();
    v_flex()
        .p(space::L)
        .gap(space::M)
        .child(
            Alert::error(id.clone(), message)
                .title(title)
                .icon(IconName::TriangleAlert),
        )
        .child(
            h_flex().child(
                Button::new(id)
                    .outline()
                    .small()
                    .icon(IconName::RefreshCw)
                    .label("Réessayer")
                    .on_click(move |_, window, cx| on_intent(Intent::Retry, window, cx)),
            ),
        )
}
