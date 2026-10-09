//! The viewer turns what the user does with the keyboard and links into intents.

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::component::Root;
use gpui_kit::{
    AppContext as _, Entity, Modifiers, MouseButton, TestAppContext, VisualTestContext, point, px,
};
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

#[test]
fn a_title_in_the_tree_drops_the_beginning_it_shares_with_its_parent() {
    use ui::viewer::short_title;
    let parent = Some("Contrats d'entretien");
    assert_eq!(short_title("Contrats d'entretien : fibre", parent), "fibre");
    assert_eq!(short_title("contrats d'entretien — box", parent), "box");
    assert_eq!(
        short_title("Contrats d'entretien", parent),
        "Contrats d'entretien"
    );
    assert_eq!(
        short_title("Contrats d'entretienX", parent),
        "Contrats d'entretienX"
    );
    assert_eq!(short_title("Facture d'août", parent), "Facture d'août");
    assert_eq!(short_title("Facture d'août", None), "Facture d'août");
}

#[gpui_kit::test]
fn a_drag_of_the_sidebar_edge_says_its_width_once_when_it_ends(cx: &mut TestAppContext) {
    let (viewer, cx, intents) = viewer(cx);
    cx.run_until_parked();
    let edge = cx
        .debug_bounds("sidebar-edge")
        .expect("the edge of the sidebar is drawn");
    let start = edge.center();
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::none());
    for step in 1..=10 {
        cx.simulate_mouse_move(
            point(start.x + px(step as f32 * 8.), start.y),
            MouseButton::Left,
            Modifiers::none(),
        );
    }
    let widths = |intents: &Rc<RefCell<Vec<Intent>>>| {
        intents
            .borrow()
            .iter()
            .filter(|intent| matches!(intent, Intent::SidebarWidth(_)))
            .count()
    };
    // While it moves, nothing is kept.
    assert_eq!(widths(&intents), 0);
    cx.simulate_mouse_up(
        point(start.x + px(80.), start.y),
        MouseButton::Left,
        Modifiers::none(),
    );
    cx.run_until_parked();
    assert_eq!(widths(&intents), 1);
    let width = viewer.read_with(cx, |viewer, _| viewer.sidebar_width());
    assert!(width > px(300.), "the sidebar is wider: {width:?}");
}

/// A viewer whose tree draws the monitor under both computers.
fn viewer_with_a_shared_entry(
    cx: &mut TestAppContext,
) -> (
    Entity<Viewer>,
    &mut VisualTestContext,
    Rc<RefCell<Vec<Intent>>>,
) {
    let (viewer, cx, intents) = viewer(cx);
    cx.update(|_, cx| {
        viewer.update(cx, |viewer, cx| {
            viewer.set_tree(
                Load::Ready(vec![
                    node(
                        "desktop",
                        vec![node("monitor", vec![]), node("keyboard", vec![])],
                    ),
                    node("laptop", vec![node("monitor", vec![])]),
                    node("garden", vec![]),
                ]),
                cx,
            );
        })
    });
    (viewer, cx, intents)
}

#[gpui_kit::test]
fn down_walks_through_an_entry_drawn_under_two_places_and_reaches_every_line(
    cx: &mut TestAppContext,
) {
    let (viewer, cx, intents) = viewer_with_a_shared_entry(cx);
    cx.update(|_, cx| viewer.update(cx, |viewer, cx| viewer.select(&"desktop".into(), cx)));
    cx.simulate_keystrokes("down down down down down");
    assert_eq!(
        *intents.borrow(),
        vec![
            Intent::Open("desktop".into()),
            Intent::Open("monitor".into()),
            Intent::Open("keyboard".into()),
            Intent::Open("laptop".into()),
            Intent::Open("monitor".into()),
            Intent::Open("garden".into())
        ]
    );
    // And back up the same way: from the second monitor, the group above it.
    cx.simulate_keystrokes("up up");
    assert_eq!(
        intents.borrow()[6..],
        [
            Intent::Open("monitor".into()),
            Intent::Open("laptop".into())
        ]
    );
}

#[gpui_kit::test]
fn left_goes_to_the_parent_of_the_occurrence_selected(cx: &mut TestAppContext) {
    let (viewer, cx, intents) = viewer_with_a_shared_entry(cx);
    cx.update(|_, cx| viewer.update(cx, |viewer, cx| viewer.select(&"laptop".into(), cx)));
    cx.simulate_keystrokes("down left");
    assert_eq!(
        *intents.borrow(),
        vec![
            Intent::Open("laptop".into()),
            Intent::Open("monitor".into()),
            Intent::Open("laptop".into())
        ]
    );
}
