//! The viewer turns what the user does with the keyboard and links into intents.

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::component::Root;
use gpui_kit::{AppContext as _, Entity, TestAppContext, VisualTestContext};
use ui::intent::{FollowLink, Intent};
use ui::load::Load;
use ui::search::SearchData;
use ui::viewer::{Pane, TreeNode, Viewer};

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
                    node("yard", vec![node("shed", vec![node("rake", vec![])])]),
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
fn moving_in_the_tree_opens_each_entry_in_the_order_shown(cx: &mut TestAppContext) {
    let (viewer, cx, intents) = viewer(cx);
    // As if the entry were clicked: then the keys move from it. A top-level folder is a group,
    // always open; the entries filed nowhere come last.
    cx.update(|_, cx| viewer.update(cx, |viewer, cx| viewer.select(&"kitchen".into(), cx)));
    cx.simulate_keystrokes("down down down down down");
    assert_eq!(
        *intents.borrow(),
        vec![
            Intent::Open("kitchen".into()),
            Intent::Open("plum-tart".into()),
            Intent::Open("yard".into()),
            Intent::Open("shed".into()),
            Intent::Open("garden".into())
        ]
    );
}

#[gpui_kit::test]
fn right_unfolds_a_folder_and_left_goes_back_up_then_folds_it(cx: &mut TestAppContext) {
    let (viewer, cx, intents) = viewer(cx);
    cx.update(|_, cx| viewer.update(cx, |viewer, cx| viewer.select(&"shed".into(), cx)));
    // Folded, the rake is not on the way down.
    cx.simulate_keystrokes("down");
    cx.simulate_keystrokes("up right down");
    cx.simulate_keystrokes("left left down");
    assert_eq!(
        *intents.borrow(),
        vec![
            Intent::Open("shed".into()),
            Intent::Open("garden".into()),
            Intent::Open("shed".into()),
            Intent::Open("rake".into()),
            Intent::Open("shed".into()),
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

#[gpui_kit::test]
fn the_open_entry_clicked_again_from_a_search_opens_it_again(cx: &mut TestAppContext) {
    let (viewer, cx, intents) = viewer(cx);
    cx.update(|window, cx| {
        viewer.update(cx, |viewer, cx| {
            viewer.select(&"garden".into(), cx);
            viewer.set_pane(
                Pane::Search(SearchData {
                    query: "rake".into(),
                    types: Vec::new(),
                    type_name: None,
                    results: Load::Loading,
                }),
                window,
                cx,
            );
            viewer.select(&"garden".into(), cx);
        })
    });
    assert_eq!(
        *intents.borrow(),
        vec![Intent::Open("garden".into()), Intent::Open("garden".into())]
    );
}

#[gpui_kit::test]
fn a_slash_typed_in_the_search_field_stays_in_it(cx: &mut TestAppContext) {
    let (viewer, cx, _) = viewer(cx);
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_input("a/b");
    let typed = viewer.read_with(cx, |viewer, cx| viewer.search_text(cx));
    assert_eq!(typed.as_ref(), "a/b");
}

#[gpui_kit::test]
fn a_slash_from_the_entry_pane_goes_to_the_search_field(cx: &mut TestAppContext) {
    let (viewer, cx, _) = viewer(cx);
    cx.update(|window, cx| viewer.update(cx, |viewer, cx| viewer.focus_pane(window, cx)));
    cx.simulate_keystrokes("/");
    cx.simulate_input("rake");
    let typed = viewer.read_with(cx, |viewer, cx| viewer.search_text(cx));
    assert_eq!(typed.as_ref(), "rake");
}

#[gpui_kit::test]
fn the_version_of_the_viewer_stands_beside_the_server(cx: &mut TestAppContext) {
    let (viewer, cx, _) = viewer(cx);
    cx.update(|_, cx| {
        viewer.update(cx, |viewer, cx| {
            viewer.set_connection(Some("grenier.example:3000".into()), cx);
            viewer.set_version("1.2.3".into(), cx);
        })
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("viewer-version").is_some());
}
