//! The generated types read what the server's read API returns.

use api::{EntryRead, SearchResults, Source, TypeList};

/// An entry as `GET /api/entries/{entry}` returns it, with invented data: a sensitive value
/// hidden, every kind of source, a medium, links both ways and a hidden child.
const ENTRY: &str = r#"{
  "entry": {
    "id": "01a1-entry", "type": "recipe", "title": "Plum tart", "slug": "plum-tart",
    "aliases": ["tarte aux prunes"], "tags": ["dessert"], "parent_id": "01a1-kitchen",
    "fields": { "serves": 6, "cost": "[hidden]" }, "provenance": { "serves": "extracted" },
    "sources": [
      { "entry": "01a1-notebook", "slug": "kitchen-notebook", "title": "Kitchen notebook" },
      { "url": "https://example.org/tarts/plum", "note": "the original" },
      { "identifier": "doc_7741", "label": "scanned page" },
      { "source": "inbox", "item": "01a1-item" }
    ],
    "body": "Bake [[pastry]] first.", "summary": "A plum tart.", "verified": false,
    "created": "2026-10-06T09:00:00.000Z", "updated": "2026-10-06T09:30:00.000Z",
    "valid_from": null, "valid_until": null, "superseded_by": null, "archived_at": null
  },
  "path": ["Kitchen"],
  "ancestors": [{ "id": "01a1-kitchen", "title": "Kitchen" }],
  "links": [{ "relation": "mentions", "period": null, "field": null, "id": "01a1-pastry", "slug": "pastry", "title": "Pastry" }],
  "media": [{
    "id": "01a1-medium", "kind": "image", "mime": "image/png", "size": 68, "sha256": "ab12",
    "width": 1, "height": 1, "duration": null, "source_url": null, "alt": "", "position": 1,
    "url": "/media/ab12"
  }],
  "backlinks": [],
  "children": [{ "id": "01a1-child", "slug": "plum-jam", "type": "recipe", "title": "Plum jam", "summary": "", "in_parent": false }],
  "hidden_children": 1,
  "cited_by": [{ "id": "01a1-menu", "slug": "sunday-menu", "title": "Sunday menu" }]
}"#;

#[test]
fn an_entry_reads_with_its_sources_media_and_links() {
    let read: EntryRead = serde_json::from_str(ENTRY).expect("an entry as the API returns it");
    assert_eq!(read.entry.title, "Plum tart");
    assert_eq!(read.hidden_children, 1);
    assert_eq!(read.media[0].width, Some(1));
    assert!(
        matches!(&read.entry.sources[0], Source::Entry(entry) if entry.title == "Kitchen notebook")
    );
    assert!(
        matches!(&read.entry.sources[1], Source::Url(url) if url.note.as_deref() == Some("the original"))
    );
    assert!(matches!(&read.entry.sources[2], Source::Identifier(_)));
    assert!(matches!(&read.entry.sources[3], Source::Item(item) if item.source == "inbox"));
}

#[test]
fn types_and_search_results_read() {
    let types: TypeList = serde_json::from_str(
        r#"{ "types": [{ "name": "recipe", "label": "Recipe", "description": "A dish.",
             "fields": [{ "name": "serves", "kind": "integer" }, { "name": "course", "kind": "enum", "values": ["starter", "main"] }] }] }"#,
    )
    .expect("types as the API returns them");
    assert_eq!(types.types[0].fields.len(), 2);
    let found: SearchResults = serde_json::from_str(
        r#"{ "results": [{ "id": "01a1-entry", "slug": "plum-tart", "type": "recipe", "title": "Plum tart",
             "summary": "", "path": ["Kitchen"], "excerpt": "<mark>plum</mark> tart", "rank": 0.6 }] }"#,
    )
    .expect("search results as the API returns them");
    assert_eq!(found.results[0].rank, 0.6);
}
