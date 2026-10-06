//! How the viewer moves, defined once: what opens unfolds to its height, a page that opens slides
//! in, and what the pointer is over fades to its hover colour. One spring and one curve for all
//! of it, so everything moves alike.

use std::time::Duration;

use gpui_kit::{Animation, prelude::FluentBuilder as _};
use gpui_kit::{
    AnimationExt as _, AnimationPhase, AnyElement, App, Div, ElementId, InteractiveElement as _,
    IntoElement, ParentElement as _, Pixels, RenderOnce, SpringAnimation, SpringConfig, Stateful,
    StatefulInteractiveElement as _, Styled as _, Window, div, ease_out_quint, px,
};

/// Critically damped: settles in about a quarter of a second, without bouncing.
pub const SPRING: SpringConfig = SpringConfig::new(300., 34.6, 1.);

/// How long a page takes to come in.
const ENTER: Duration = Duration::from_millis(260);

/// How far a page travels as it comes in.
const RISE: Pixels = px(8.);

/// Content that unfolds to its own height when `open`, folds away when not, and fades as it
/// goes. Its height is measured, so it may hold anything.
#[derive(IntoElement)]
pub struct Reveal {
    id: ElementId,
    open: bool,
    child: AnyElement,
}

pub fn reveal(id: impl Into<ElementId>, open: bool, child: impl IntoElement) -> Reveal {
    Reveal {
        id: id.into(),
        open,
        child: child.into_any_element(),
    }
}

impl RenderOnce for Reveal {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let measured = window.use_keyed_state(self.id.clone(), cx, |_, _| None::<Pixels>);
        let height = *measured.read(cx);
        let open = self.open;
        div()
            .overflow_hidden()
            .on_children_prepainted(move |bounds, _, cx| {
                if let Some(child) = bounds.first() {
                    let child_height = child.size.height;
                    measured.update(cx, |height, cx| {
                        if *height != Some(child_height) {
                            *height = Some(child_height);
                            cx.notify();
                        }
                    });
                }
            })
            .child(div().flex_none().child(self.child))
            .with_spring(
                self.id,
                SpringAnimation::new(SPRING).to(open),
                move |element, phase| {
                    let shown = phase.0.clamp(0., 1.);
                    match height {
                        // Settled open: the content takes the height it needs.
                        _ if open && shown > 0.999 => element,
                        Some(height) => element.h(height * shown).opacity(shown),
                        None => element.when(!open, |element| element.h(px(0.))),
                    }
                },
            )
    }
}

/// A page coming in: it fades in as it rises a little, `delay` after it is shown. A new `id`
/// plays it again.
pub fn enter(id: impl Into<ElementId>, delay: Duration, page: impl IntoElement) -> AnyElement {
    div()
        .relative()
        .child(page)
        .with_animations(
            id,
            vec![
                Animation::new(delay.max(Duration::from_millis(1))),
                Animation::new(ENTER).with_easing(ease_out_quint()),
            ],
            |element, step, progress| {
                let shown = if step == 0 { 0. } else { progress };
                element.opacity(shown).top(RISE * (1. - shown))
            },
        )
        .into_any_element()
}

/// An element that follows the pointer: `style` gets it and how far it is into its hover state,
/// from 0 (away) to 1 (over), and moves between the two on the spring.
pub fn hoverable(
    id: impl Into<ElementId>,
    window: &mut Window,
    cx: &mut App,
    style: impl FnOnce(Stateful<Div>, AnimationPhase) -> Stateful<Div> + 'static,
) -> AnyElement {
    let id = id.into();
    let hovered = window.use_keyed_state(id.clone(), cx, |_, _| false);
    let over = *hovered.read(cx);
    div()
        .id(id.clone())
        .on_hover(move |now, _, cx| {
            hovered.update(cx, |over, cx| {
                if *over != *now {
                    *over = *now;
                    cx.notify();
                }
            })
        })
        .with_spring(
            id,
            SpringAnimation::new(SPRING).to(over),
            move |element, phase| style(element, AnimationPhase(phase.0.clamp(0., 1.))),
        )
        .into_any_element()
}
