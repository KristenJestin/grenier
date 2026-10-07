//! The viewer on a server: the tree, an entry, a link followed, back, a search; and a server
//! that stops answering, then comes back.

use std::io::{BufRead as _, BufReader, Write as _};
use std::net::TcpListener;
use std::thread;

use app::client::{Client, Key};
use app::shell::Shell;
use gpui_kit::{Entity, Modifiers, TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use ui::intent::Intent;
use ui::load::{Load, Problem};
use ui::viewer::{Pane, Viewer};

fn entry(id: &str, title: &str, parent: Option<&str>, body: &str) -> Value {
    json!({
        "entry": {
            "id": id, "type": "note", "title": title, "slug": id, "aliases": [], "tags": [],
            "parent_id": parent, "fields": {}, "provenance": {}, "sources": [], "body": body,
            "summary": "", "verified": true, "created": "2026-09-01T08:00:00.000Z",
            "updated": "2026-10-01T08:00:00.000Z", "valid_from": null, "valid_until": null,
            "superseded_by": null, "archived_at": null
        },
        "path": [], "links": [], "media": [], "backlinks": [], "children": [],
        "hidden_children": 0, "cited_by": []
    })
}

/// A server on `listener` that answers the read API with invented entries, until the test ends.
fn serve(listener: TcpListener) {
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
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
                        { "id": "stand", "slug": "stand", "type": "item", "title": "Stand", "parent_id": "screen", "in_parent": true }
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
    });
}

fn viewer_on(server: String, cx: &mut TestAppContext) -> (Entity<Viewer>, &mut VisualTestContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        ui::viewer::init(cx);
    });
    let (shell, cx) = cx.add_window_view(|window, cx| {
        Shell::new(Ok(Client::new(server, Key::new("test-key"))), window, cx)
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
        Pane::Entry(_) => Vec::new(),
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
            ("screen".to_string(), 0)
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
