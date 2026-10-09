//! The generated types read what the server's read API returns.

use api::{EntryProvenanceValue, EntryRead, LinkProvenance, SearchResults, Source, TypeList};

/// An entry as `GET /api/entries/{entry}` returns it, with invented data: a sensitive value
/// hidden, every kind of source, a medium, links both ways and a hidden child.
const ENTRY: &str = r#"{
  "entry": {
    "id": "01a1-entry", "type": "recipe", "title": "Plum tart", "slug": "plum-tart",
    "aliases": ["tarte aux prunes"], "tags": ["dessert"], "parent_id": "01a1-kitchen",
    "fields": { "serves": 6, "cost": "[hidden]", "bought_from": ["01a1-market", "01a1-farm"] }, "provenance": { "serves": "extracted", "cost": "inferred", "body": "unstated", "summary": "inferred" },
    "sources": [
      { "entry": "01a1-notebook", "slug": "kitchen-notebook", "title": "Kitchen notebook" },
      { "url": "https://example.org/tarts/plum", "note": "the original" },
      { "said_by": "01a1-marie", "slug": "marie", "title": "Marie", "on": "2026-10-08", "note": "at lunch" },
      { "identifier": "doc_7741", "label": "scanned page" },
      { "source": "inbox", "item": "01a1-item" }
    ],
    "body": "Bake [[pastry]] first.", "summary": "A plum tart.",
    "created": "2026-10-06T09:00:00.000Z", "updated": "2026-10-06T09:30:00.000Z",
    "valid_from": null, "valid_until": null, "superseded_by": null, "archived_at": null, "archived_reason": null
  },
  "path": ["Kitchen"],
  "ancestors": [{ "id": "01a1-kitchen", "title": "Kitchen" }],
  "references": [{ "reference": "pastry", "id": "01a1-pastry", "title": "Pastry" }],
  "links": [
    { "relation": "mentions", "provenance": "extracted", "period": null, "field": null, "note": null, "valid_from": null, "valid_until": null, "id": "01a1-pastry", "slug": "pastry", "title": "Pastry" },
    { "relation": "bought_at", "provenance": "inferred", "period": null, "field": null, "note": "the plums", "valid_from": "2026-09-01", "valid_until": "2026-09-30", "id": "01a1-market", "slug": "market", "title": "Market" }
  ],
  "media": [{
    "id": "01a1-medium", "kind": "image", "mime": "image/png", "size": 68, "sha256": "ab12",
    "width": 1, "height": 1, "duration": null, "source_url": null, "alt": "", "position": 1,
    "url": "/media/ab12"
  }],
  "backlinks": [],
  "children": [{ "id": "01a1-child", "slug": "plum-jam", "type": "recipe", "title": "Plum jam", "summary": "", "in_parent": false }],
  "hidden_children": 1,
  "cited_by": [{ "id": "01a1-menu", "slug": "sunday-menu", "title": "Sunday menu" }],
  "titles": { "01a1-market": "Market", "01a1-farm": "Farm" }
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
    assert!(
        matches!(&read.entry.sources[2], Source::Said(said) if said.slug == "marie" && said.on == "2026-10-08")
    );
    assert!(matches!(&read.entry.sources[3], Source::Identifier(_)));
    assert!(matches!(&read.entry.sources[4], Source::Item(item) if item.source == "inbox"));
}

#[test]
fn every_value_says_whether_it_is_known_or_supposed() {
    let read: EntryRead = serde_json::from_str(ENTRY).expect("an entry as the API returns it");
    let provenance = &read.entry.provenance;
    assert_eq!(provenance["serves"], EntryProvenanceValue::Extracted);
    assert_eq!(provenance["cost"], EntryProvenanceValue::Inferred);
    assert_eq!(provenance["body"], EntryProvenanceValue::Unstated);
    assert_eq!(provenance["summary"], EntryProvenanceValue::Inferred);
    assert_eq!(read.links[0].provenance, LinkProvenance::Extracted);
    assert_eq!(read.links[1].provenance, LinkProvenance::Inferred);
}

#[test]
fn a_repeated_field_and_a_link_with_a_note_and_dates_read() {
    let read: EntryRead = serde_json::from_str(ENTRY).expect("an entry as the API returns it");
    assert_eq!(
        read.entry.fields["bought_from"],
        serde_json::json!(["01a1-market", "01a1-farm"])
    );
    assert_eq!(read.titles["01a1-farm"], "Farm");
    let bought = &read.links[1];
    assert_eq!(bought.note.as_deref(), Some("the plums"));
    assert_eq!(bought.valid_from.as_deref(), Some("2026-09-01"));
    assert_eq!(bought.valid_until.as_deref(), Some("2026-09-30"));
    assert_eq!(read.links[0].note, None);
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
             "summary": "", "summary_provenance": "ambiguous", "path": ["Kitchen"],
             "excerpt": "<mark>plum</mark> tart", "rank": 0.6,
             "supposed": [{ "what": "summary", "provenance": "ambiguous", "by": "agent-laptop", "when": "2026-10-08T09:00:00Z" }] }] }"#,
    )
    .expect("search results as the API returns them");
    assert_eq!(found.results[0].rank, 0.6);
    assert_eq!(found.results[0].supposed[0].what, "summary");
}

#[test]
fn an_answer_with_keys_a_newer_server_added_still_reads() {
    let newer = ENTRY.replacen(
        r#""hidden_children": 1,"#,
        r#""hidden_children": 1, "added_later": { "any": ["shape"] },"#,
        1,
    );
    let read: EntryRead = serde_json::from_str(&newer).expect("unknown keys are ignored");
    assert_eq!(read.entry.slug, "plum-tart");
}
