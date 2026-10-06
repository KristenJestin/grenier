//! The viewer turns what the user does with the keyboard and links into intents.

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::component::Root;
use gpui_kit::{AppContext as _, Entity, TestAppContext, VisualTestContext};
use ui::intent::{FollowLink, Intent};
use ui::load::Load;
use ui::viewer::{TreeNode, Viewer};

fn node(id: &str, children: Vec<TreeNode>) -> TreeNode {
    TreeNode {
        id: id.to_string().into(),
        title: id.to_string().into(),
        type_name: "note".into(),
        archived: false,
        children,
    }
}

/// A viewer in a window, its tree loaded, and the intents it emits.
fn viewer(
    cx: &mut TestAppContext,
) -> (
    Entity<Viewer>,
    &mut VisualTestContext,
    Rc<RefCell<Vec<Intent>>>,
) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        ui::viewer::init(cx);
    });
    let mut created = None;
    let (_root, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| Viewer::new(window, cx));
        created = Some(view.clone());
        Root::new(view, window, cx)
    });
    let viewer = created.expect("the viewer is created");
    let intents = Rc::new(RefCell::new(Vec::new()));
    let seen = intents.clone();
    cx.update(|window, cx| {
        cx.subscribe(&viewer, move |_, intent: &Intent, _| {
            seen.borrow_mut().push(intent.clone())
        })
        .detach();
        viewer.update(cx, |viewer, cx| {
            viewer.set_tree(
                Load::Ready(vec![
                    node("kitchen", vec![node("plum-tart", vec![])]),
                    node("garden", vec![]),
                ]),
                cx,
            );
            viewer.focus_tree(window, cx);
        });
    });
    (viewer, cx, intents)
}

#[gpui_kit::test]
fn moving_in_the_tree_opens_each_entry_and_right_expands(cx: &mut TestAppContext) {
    let (viewer, cx, intents) = viewer(cx);
    // As if the entry were clicked: then the keys move from it.
    cx.update(|_, cx| viewer.update(cx, |viewer, cx| viewer.select(&"kitchen".into(), cx)));
    cx.simulate_keystrokes("right");
    cx.simulate_keystrokes("down");
    cx.simulate_keystrokes("down");
    assert_eq!(
        *intents.borrow(),
        vec![
            Intent::Open("kitchen".into()),
            Intent::Open("plum-tart".into()),
            Intent::Open("garden".into())
        ]
    );
}

#[gpui_kit::test]
fn a_reference_in_a_body_opens_its_entry_and_a_web_link_the_browser(cx: &mut TestAppContext) {
    let (_, cx, intents) = viewer(cx);
    cx.dispatch_action(FollowLink {
        url: "grenier://plum-tart".into(),
    });
    cx.dispatch_action(FollowLink {
        url: "https://example.org/".into(),
    });
    assert_eq!(
        *intents.borrow(),
        vec![
            Intent::Open("plum-tart".into()),
            Intent::OpenUrl("https://example.org/".into())
        ]
    );
}

#[gpui_kit::test]
fn back_and_forward_have_their_keys(cx: &mut TestAppContext) {
    let (_, cx, intents) = viewer(cx);
    cx.simulate_keystrokes("alt-left alt-right");
    assert_eq!(*intents.borrow(), vec![Intent::Back, Intent::Forward]);
}
