//! The viewer on a server: the tree, an entry, a link followed, back, a search; and a server
//! that stops answering, then comes back.

use std::io::{BufRead as _, BufReader, Write as _};
use std::net::TcpListener;
use std::thread;

use app::client::{Client, Key};
use app::shell::Shell;
use gpui_kit::{Entity, Modifiers, TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::time::Duration;

use gpui_kit::px;
use ui::intent::{FollowLink, Intent, ListFilter};
use ui::load::{Load, Problem};
use ui::viewer::{Pane, Viewer};

fn entry(id: &str, title: &str, parent: Option<&str>, body: &str) -> Value {
    json!({
        "entry": {
            "id": id, "type": "note", "title": title, "slug": id, "aliases": [], "tags": [],
            "parent_id": parent, "fields": {}, "provenance": {}, "sources": [], "body": body,
            "summary": "", "created": "2026-09-01T08:00:00.000Z",
            "updated": "2026-10-01T08:00:00.000Z", "valid_from": null, "valid_until": null,
            "superseded_by": null, "archived_at": null, "archived_reason": null
        },
        "path": [], "ancestors": [], "references": [], "links": [], "media": [], "backlinks": [], "children": [],
        "hidden_children": 0, "cited_by": [], "titles": {}
    })
}

/// A server on `listener` that answers the read API with invented entries, until the test ends.
fn serve(listener: TcpListener) {
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            // Each request on its own thread: a slow answer holds no other.
            thread::spawn(move || answer(stream));
        }
    });
}

/// Answers one request of the read API with invented entries.
fn answer(mut stream: std::net::TcpStream) {
    {
        {
            let mut line = String::new();
            BufReader::new(&stream).read_line(&mut line).ok();
            let path = line.split(' ').nth(1).unwrap_or("").to_string();
            let (status, body) = match path.as_str() {
                "/api/types" => (
                    "200 OK",
                    json!({ "types": [{
                        "name": "item", "label": "Item", "description": "Something owned, or a part of it.",
                        "read_in_parent": true,
                        "fields": [
                            { "name": "serial", "kind": "text" },
                            { "name": "price", "kind": "money", "sensitive": true }
                        ]
                    }, {
                        "name": "person", "label": "Person", "description": "Someone known.",
                        "fields": [{ "name": "visits", "kind": "entry", "many": true }]
                    }]}),
                ),
                "/api/entries" => (
                    "200 OK",
                    json!({ "entries": [
                        { "id": "kitchen", "slug": "kitchen", "type": "note", "title": "Kitchen", "parent_id": null, "in_parent": false },
                        { "id": "plum-tart", "slug": "plum-tart", "type": "note", "title": "Plum tart", "parent_id": "kitchen", "in_parent": false },
                        { "id": "computer", "slug": "computer", "type": "item", "title": "Computer", "parent_id": null, "in_parent": false },
                        { "id": "main-disk", "slug": "main-disk", "type": "item", "title": "Main disk", "parent_id": "computer", "in_parent": true },
                        { "id": "fan", "slug": "fan", "type": "item", "title": "Fan", "parent_id": "computer", "in_parent": true },
                        { "id": "screen", "slug": "screen", "type": "item", "title": "Screen", "parent_id": null, "in_parent": false },
                        { "id": "stand", "slug": "stand", "type": "item", "title": "Stand", "parent_id": "screen", "in_parent": true },
                        { "id": "attic", "slug": "attic", "type": "note", "title": "Attic", "parent_id": null, "in_parent": false },
                        { "id": "letters", "slug": "letters", "type": "note", "title": "Letters", "parent_id": "old-trunk", "in_parent": false }
                    ]}),
                ),
                "/api/entries/computer" => {
                    let mut computer = entry("computer", "Computer", None, "");
                    computer["entry"]["type"] = json!("item");
                    computer["children"] = json!([
                        { "id": "fan", "slug": "fan", "type": "item", "title": "Fan", "summary": "", "in_parent": true, "fields": {} },
                        { "id": "main-disk", "slug": "main-disk", "type": "item", "title": "Main disk", "summary": "", "in_parent": true,
                          "fields": { "serial": "SN-0001", "price": "[hidden]" } }
                    ]);
                    ("200 OK", computer)
                }
                "/api/entries/main-disk" => (
                    "200 OK",
                    entry("main-disk", "Main disk", Some("computer"), ""),
                ),
                "/api/entries/attic" => {
                    let mut attic = entry("attic", "Attic", None, "");
                    attic["entry"]["tags"] = json!(["dusty"]);
                    attic["backlinks"] = json!((1..=8).map(|n| json!({
                        "relation": "mentions", "provenance": "extracted", "period": null, "field": null, "note": null,
                        "valid_from": null, "valid_until": null,
                        "id": format!("box-{n}"), "slug": format!("box-{n}"), "title": format!("Box {n}")
                    })).collect::<Vec<_>>());
                    ("200 OK", attic)
                }
                "/api/entries?tag=dusty" => (
                    "200 OK",
                    json!({ "entries": [
                        { "id": "attic", "slug": "attic", "type": "note", "title": "Attic", "parent_id": null, "in_parent": false },
                        { "id": "letters", "slug": "letters", "type": "note", "title": "Letters", "parent_id": "old-trunk", "in_parent": false }
                    ], "next_cursor": null }),
                ),
                "/api/entries?supposed=true" => (
                    "200 OK",
                    json!({ "entries": [
                        { "id": "harbor", "slug": "harbor", "type": "note", "title": "Harbor", "parent_id": null, "in_parent": false }
                    ], "next_cursor": null }),
                ),
                "/api/entries/harbor" => {
                    // A summary, a link and a body the writer only supposed; the tags are known.
                    let mut harbor = entry("harbor", "Harbor", None, "Probably a quiet one.");
                    harbor["entry"]["summary"] = json!("A small harbor.");
                    harbor["entry"]["provenance"] =
                        json!({ "summary": "inferred", "body": "inferred" });
                    harbor["links"] = json!([{
                        "relation": "near", "provenance": "inferred", "period": null, "field": null,
                        "note": null, "valid_from": null, "valid_until": null,
                        "id": "kitchen", "slug": "kitchen", "title": "Kitchen"
                    }]);
                    ("200 OK", harbor)
                }
                "/api/entries/attic/history" => (
                    "200 OK",
                    json!({ "events": [{ "id": "9", "at": "2026-10-07T08:00:00.000Z", "actor": "agent-test",
                        "action": "update", "changes": [{ "field": "summary", "before": "", "after": "Dusty." }] }],
                        "next_cursor": "9" }),
                ),
                "/api/entries/plum-tart/history" => {
                    // Answered late: the owner has opened another entry by then.
                    thread::sleep(Duration::from_millis(400));
                    (
                        "200 OK",
                        json!({ "events": [{ "id": "77", "at": "2026-10-07T08:00:00.000Z", "actor": "agent-test",
                            "action": "update", "changes": [] }], "next_cursor": "77" }),
                    )
                }
                listing if listing.starts_with("/api/entries?type=note") => {
                    // 120 notes, 50 a page, the next page after the cursor `<n>`.
                    let from: usize = listing
                        .split("cursor=")
                        .nth(1)
                        .and_then(|cursor| cursor.parse().ok())
                        .unwrap_or(0);
                    let to = (from + 50).min(120);
                    let entries: Vec<Value> = (from..to)
                        .map(|n| json!({ "id": format!("note-{n:03}"), "slug": format!("note-{n:03}"), "type": "note",
                            "title": format!("Note {n:03}"), "parent_id": null, "in_parent": false }))
                        .collect();
                    let next = if to < 120 {
                        json!(to.to_string())
                    } else {
                        Value::Null
                    };
                    ("200 OK", json!({ "entries": entries, "next_cursor": next }))
                }
                "/api/entries/attic/history?cursor=9" => (
                    "200 OK",
                    json!({ "events": [{ "id": "2", "at": "2026-09-01T08:00:00.000Z", "actor": "agent-test",
                        "action": "create", "changes": [{ "field": "title", "before": null, "after": "Attic" }] }],
                        "next_cursor": null }),
                ),
                "/api/entries/neighbour" => {
                    let mut neighbour = entry("neighbour", "Neighbour", None, "");
                    neighbour["entry"]["type"] = json!("person");
                    neighbour["entry"]["fields"] = json!({ "visits": ["kitchen", "attic"] });
                    neighbour["titles"] = json!({ "kitchen": "Kitchen", "attic": "Attic" });
                    neighbour["links"] = json!([{
                        "relation": "works_at", "provenance": "extracted", "period": null, "field": null, "note": "gardener",
                        "valid_from": "2024-01-01", "valid_until": null,
                        "id": "kitchen", "slug": "kitchen", "title": "Kitchen"
                    }]);
                    ("200 OK", neighbour)
                }
                "/api/entries/letters" => {
                    // Filed under a trunk that is archived, so absent from the tree.
                    let mut letters = entry("letters", "Letters", Some("old-trunk"), "");
                    letters["path"] = json!(["Attic", "Old trunk"]);
                    letters["ancestors"] = json!([
                        { "id": "attic", "title": "Attic" },
                        { "id": "old-trunk", "title": "Old trunk" }
                    ]);
                    ("200 OK", letters)
                }
                "/api/entries/orchard" => {
                    let filler = "A line about the trees, to make the page long.\n\n".repeat(80);
                    let body = format!("{filler}## Pruning\n\nIn late winter.\n\n{filler}");
                    ("200 OK", entry("orchard", "Orchard", None, &body))
                }
                "/api/entries/kitchen" => ("200 OK", entry("kitchen", "Kitchen", None, "")),
                "/api/entries/plum-tart" => (
                    "200 OK",
                    entry(
                        "plum-tart",
                        "Plum tart",
                        Some("kitchen"),
                        "In the [[kitchen]].",
                    ),
                ),
                search if search.starts_with("/api/search?q=plum") => (
                    "200 OK",
                    json!({ "results": [{
                        "id": "plum-tart", "slug": "plum-tart", "type": "note", "title": "Plum tart",
                        "path": ["Kitchen"], "summary": "", "excerpt": "A <mark>plum</mark> tart.", "rank": 1.0
                    }]}),
                ),
                _ => (
                    "404 Not Found",
                    json!({ "_tag": "NotFound", "message": "Nothing here." }),
                ),
            };
            let body = body.to_string();
            let answer = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(answer.as_bytes()).ok();
        }
    }
}

fn viewer_on(server: String, cx: &mut TestAppContext) -> (Entity<Viewer>, &mut VisualTestContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        ui::viewer::init(cx);
    });
    let (shell, cx) = cx.add_window_view(|window, cx| {
        Shell::new(
            Ok(Client::new(server, Key::new("test-key"))),
            &app::config::Preferences::default(),
            window,
            cx,
        )
    });
    let viewer = shell.read_with(cx, |shell, _| shell.viewer().clone());
    (viewer, cx)
}

fn ask(viewer: &Entity<Viewer>, intent: Intent, cx: &mut VisualTestContext) {
    cx.update(|_, cx| viewer.update(cx, |_, cx| cx.emit(intent)));
    cx.run_until_parked();
}

fn opened(viewer: &Entity<Viewer>, cx: &mut VisualTestContext) -> Option<String> {
    viewer.read_with(cx, |viewer, _| viewer.opened().map(str::to_string))
}

#[gpui_kit::test]
fn the_tree_an_entry_a_link_back_and_a_search(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    assert!(viewer.read_with(cx, |viewer, _| matches!(
        viewer.tree_state(),
        Load::Ready(())
    )));
    ask(&viewer, Intent::Open("plum-tart".into()), cx);
    assert_eq!(opened(&viewer, cx).as_deref(), Some("plum-tart"));
    ask(&viewer, Intent::Open("kitchen".into()), cx);
    assert_eq!(opened(&viewer, cx).as_deref(), Some("kitchen"));
    ask(&viewer, Intent::Back, cx);
    assert_eq!(opened(&viewer, cx).as_deref(), Some("plum-tart"));
    ask(
        &viewer,
        Intent::Search {
            query: "plum".into(),
            type_name: None,
        },
        cx,
    );
    let found = viewer.read_with(cx, |viewer, _| match viewer.pane() {
        Pane::Search(search) => match &search.results {
            Load::Ready(results) => results.iter().map(|result| result.slug.clone()).collect(),
            _ => Vec::new(),
        },
        Pane::Entry(_) | Pane::List(_) => Vec::new(),
    });
    assert_eq!(found, vec!["plum-tart".to_string()]);
}

#[gpui_kit::test]
fn a_server_that_stops_answering_shows_it_and_recovers_on_retry(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let address = listener.local_addr().expect("an address");
    drop(listener);
    let (viewer, cx) = viewer_on(format!("http://{address}"), cx);
    cx.run_until_parked();
    assert!(viewer.read_with(cx, |viewer, _| {
        matches!(viewer.tree_state(), Load::Failed(Problem::Unreachable))
    }));
    serve(TcpListener::bind(address).expect("the same port, again"));
    ask(&viewer, Intent::Retry, cx);
    assert!(viewer.read_with(cx, |viewer, _| matches!(
        viewer.tree_state(),
        Load::Ready(())
    )));
}

#[gpui_kit::test]
fn the_parts_of_an_object_are_a_table_in_its_page_not_branches_of_the_tree(
    cx: &mut TestAppContext,
) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    // The parts are not branches: the computer and the screen are not even folders.
    let tree: Vec<(String, usize)> = viewer.read_with(cx, |viewer, _| {
        viewer
            .nodes()
            .iter()
            .map(|node| (node.id.to_string(), node.children.len()))
            .collect()
    });
    assert_eq!(
        tree,
        vec![
            ("kitchen".to_string(), 1),
            ("computer".to_string(), 0),
            ("screen".to_string(), 0),
            ("attic".to_string(), 0),
            ("letters".to_string(), 0)
        ]
    );
    ask(&viewer, Intent::Open("computer".into()), cx);
    cx.run_until_parked();
    let row = cx
        .debug_bounds("part-main-disk")
        .expect("the main disk is a row of the table");
    cx.simulate_click(row.center(), Modifiers::none());
    cx.run_until_parked();
    assert_eq!(opened(&viewer, cx).as_deref(), Some("main-disk"));
}

#[gpui_kit::test]
fn a_crumb_opens_its_ancestor_even_when_one_between_is_archived(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    ask(&viewer, Intent::Open("letters".into()), cx);
    cx.run_until_parked();
    let crumb = cx
        .debug_bounds("crumb-0")
        .expect("the first crumb is drawn");
    cx.simulate_click(crumb.center(), Modifiers::none());
    cx.run_until_parked();
    assert_eq!(opened(&viewer, cx).as_deref(), Some("attic"));
}

#[gpui_kit::test]
fn a_reference_to_a_heading_opens_the_entry_at_that_heading(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    // As from a link of a body, where the viewer hears it.
    cx.update(|window, cx| viewer.update(cx, |viewer, cx| viewer.focus_tree(window, cx)));
    cx.dispatch_action(FollowLink {
        url: "grenier://orchard#pruning".into(),
    });
    cx.run_until_parked();
    assert_eq!(opened(&viewer, cx).as_deref(), Some("orchard"));
    // Drawn, measured, then glided to.
    for _ in 0..3 {
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_secs(1));
        cx.run_until_parked();
    }
    let offset = viewer.read_with(cx, |viewer, _| viewer.scroll().offset().y);
    assert!(
        offset < px(-200.),
        "the page is scrolled to the heading: {offset:?}"
    );
}

#[gpui_kit::test]
fn each_value_of_a_repeated_entry_field_opens_its_entry(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    ask(&viewer, Intent::Open("neighbour".into()), cx);
    settle(cx);
    let header = cx
        .debug_bounds("fields-header")
        .expect("the fields are drawn, folded");
    cx.simulate_click(header.center(), Modifiers::none());
    settle(cx);
    let second = cx
        .debug_bounds("field-visits-1-entry")
        .expect("the second value is drawn, as a link");
    cx.simulate_click(second.center(), Modifiers::none());
    cx.run_until_parked();
    assert_eq!(opened(&viewer, cx).as_deref(), Some("attic"));
}

#[gpui_kit::test]
fn clicking_a_tag_lists_the_entries_with_that_tag(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    ask(&viewer, Intent::Open("attic".into()), cx);
    settle(cx);
    let tag = cx
        .debug_bounds("chip-tag-dusty")
        .expect("the tag is a chip");
    cx.simulate_click(tag.center(), Modifiers::none());
    cx.run_until_parked();
    let listed = viewer.read_with(cx, |viewer, _| match viewer.pane() {
        Pane::List(list) => match &list.entries {
            Load::Ready(entries) => (
                list.filter.tag.as_ref().map(ToString::to_string),
                entries.iter().map(|entry| entry.title.clone()).collect(),
            ),
            _ => (None, Vec::new()),
        },
        _ => (None, Vec::new()),
    });
    assert_eq!(
        listed,
        (
            Some("dusty".to_string()),
            vec!["Attic".to_string(), "Letters".to_string()]
        )
    );
}

#[gpui_kit::test]
fn the_history_comes_newest_first_and_older_pages_on_demand(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    ask(&viewer, Intent::Open("attic".into()), cx);
    let history = |viewer: &Entity<Viewer>, cx: &mut VisualTestContext| {
        viewer.read_with(cx, |viewer, _| {
            match viewer
                .entry()
                .map(|data| (&data.history, data.more_history))
            {
                Some((Load::Ready(events), more)) => (
                    events
                        .iter()
                        .map(|event| event.id.clone())
                        .collect::<Vec<_>>(),
                    more,
                ),
                _ => (Vec::new(), false),
            }
        })
    };
    ask(&viewer, Intent::History, cx);
    assert_eq!(history(&viewer, cx), (vec!["9".to_string()], true));
    ask(&viewer, Intent::History, cx);
    assert_eq!(
        history(&viewer, cx),
        (vec!["9".to_string(), "2".to_string()], false)
    );
}

#[gpui_kit::test]
fn a_group_of_links_folded_shows_five_and_opens_whole(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    ask(&viewer, Intent::Open("attic".into()), cx);
    settle(cx);
    assert!(cx.debug_bounds("links-in-mentions").is_some());
    assert!(cx.debug_bounds("link-in-mentions-box-5").is_some());
    assert!(cx.debug_bounds("link-in-mentions-box-6").is_none());
    let open = cx
        .debug_bounds("links-toggle-in-mentions")
        .expect("a group of eight opens whole");
    cx.simulate_click(open.center(), Modifiers::none());
    settle(cx);
    assert!(cx.debug_bounds("link-in-mentions-box-8").is_some());
}

#[gpui_kit::test]
fn a_history_answered_after_another_entry_is_opened_is_dropped(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    ask(&viewer, Intent::Open("plum-tart".into()), cx);
    // "Show the history", then another entry before the answer comes.
    cx.update(|_, cx| {
        viewer.update(cx, |_, cx| {
            cx.emit(Intent::History);
            cx.emit(Intent::Open("attic".into()));
        })
    });
    cx.run_until_parked();
    std::thread::sleep(Duration::from_millis(600));
    cx.run_until_parked();
    assert_eq!(opened(&viewer, cx).as_deref(), Some("attic"));
    let history = viewer.read_with(cx, |viewer, _| {
        viewer
            .entry()
            .map(|data| matches!(data.history, Load::Empty))
    });
    assert_eq!(
        history,
        Some(true),
        "the history of plum-tart is not shown on attic"
    );
}

#[gpui_kit::test]
fn a_listing_of_120_entries_comes_in_pages_to_the_end(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    let filter = ListFilter {
        type_name: Some(("note".into(), "Note".into())),
        ..ListFilter::default()
    };
    ask(&viewer, Intent::List(filter), cx);
    let listed = |viewer: &Entity<Viewer>, cx: &mut VisualTestContext| {
        viewer.read_with(cx, |viewer, _| match viewer.pane() {
            Pane::List(list) => match &list.entries {
                Load::Ready(entries) => (entries.len(), list.more),
                _ => (0, false),
            },
            _ => (0, false),
        })
    };
    assert_eq!(listed(&viewer, cx), (50, true));
    ask(&viewer, Intent::MoreListed, cx);
    assert_eq!(listed(&viewer, cx), (100, true));
    ask(&viewer, Intent::MoreListed, cx);
    assert_eq!(listed(&viewer, cx), (120, false));
}

#[gpui_kit::test]
fn removing_the_last_filter_closes_the_listing(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    ask(&viewer, Intent::Open("attic".into()), cx);
    ask(
        &viewer,
        Intent::List(ListFilter {
            tag: Some("dusty".into()),
            ..ListFilter::default()
        }),
        cx,
    );
    ask(&viewer, Intent::List(ListFilter::default()), cx);
    // Back to what was open before the listing.
    assert_eq!(opened(&viewer, cx).as_deref(), Some("attic"));
}

/// Lets the page play its motion to the end: a spring moves one frame at each drawing.
fn settle(cx: &mut VisualTestContext) {
    for _ in 0..120 {
        cx.update(|window, _| window.refresh());
        cx.executor().advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
    }
}

#[gpui_kit::test]
fn an_entry_with_suppositions_says_so_and_lists_those_that_do(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    serve(listener);
    let (viewer, cx) = viewer_on(server, cx);
    cx.run_until_parked();
    // What is known carries no mark.
    ask(&viewer, Intent::Open("kitchen".into()), cx);
    settle(cx);
    assert!(cx.debug_bounds("chip-type").is_some());
    assert!(cx.debug_bounds("chip-supposed").is_none());
    ask(&viewer, Intent::Open("harbor".into()), cx);
    settle(cx);
    let chip = cx
        .debug_bounds("chip-supposed")
        .expect("an entry that holds suppositions says so");
    cx.simulate_click(chip.center(), Modifiers::none());
    cx.run_until_parked();
    let listed = viewer.read_with(cx, |viewer, _| match viewer.pane() {
        Pane::List(list) => match &list.entries {
            Load::Ready(entries) => (
                list.filter.supposed,
                entries.iter().map(|entry| entry.title.clone()).collect(),
            ),
            _ => (false, Vec::new()),
        },
        _ => (false, Vec::new()),
    });
    assert_eq!(listed, (true, vec!["Harbor".to_string()]));
}
