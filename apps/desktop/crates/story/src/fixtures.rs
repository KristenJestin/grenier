//! Invented data for the stories: no real person, place, amount or document.

use api::{EntryRead, SearchResult, TypeDefinition};
use serde_json::{Value, json};
use ui::entry::EntryData;
use ui::viewer::TreeNode;

fn read(value: Value) -> EntryRead {
    serde_json::from_value(value).expect("a fixture entry reads as the API returns it")
}

fn entry(id: &str, title: &str, type_name: &str, extra: Value) -> Value {
    let mut base = json!({
        "id": id, "type": type_name, "title": title, "slug": id,
        "aliases": [], "tags": [], "parent_id": null, "fields": {}, "provenance": {},
        "sources": [], "body": "", "summary": "", "verified": true,
        "created": "2026-09-01T08:00:00.000Z", "updated": "2026-10-01T08:00:00.000Z",
        "valid_from": null, "valid_until": null, "superseded_by": null, "archived_at": null
    });
    if let (Value::Object(base), Value::Object(extra)) = (&mut base, extra) {
        base.extend(extra);
    }
    base
}

fn around(entry: Value, extra: Value) -> Value {
    let mut base = json!({
        "entry": entry, "path": [], "links": [], "media": [], "backlinks": [],
        "children": [], "hidden_children": 0, "cited_by": []
    });
    if let (Value::Object(base), Value::Object(extra)) = (&mut base, extra) {
        base.extend(extra);
    }
    base
}

fn contract_type() -> TypeDefinition {
    serde_json::from_value(json!({
        "name": "contract", "label": "Contrat", "description": "Un contrat suivi dans le temps.",
        "fields": [
            { "name": "provider", "kind": "text" },
            { "name": "start", "kind": "date" },
            { "name": "renewal", "kind": "enum", "values": ["tacite", "manuel"] },
            { "name": "monthly_cost", "kind": "money", "sensitive": true },
            { "name": "customer_area", "kind": "url" },
            { "name": "seats", "kind": "integer" },
            { "name": "paper_copy", "kind": "boolean" },
            { "name": "signed_by", "kind": "entry" }
        ]
    }))
    .expect("a fixture type")
}

const BODY: &str = "## Ce que couvre le contrat\n\nLa fibre de la maison, avec la box et la ligne fixe. \
Voir aussi [[box-du-salon]] et la [[facture-de-septembre]].\n\n\
- Débit : 1 Gb/s\n- Engagement : aucun\n- Préavis : 30 jours\n\n\
> Le service client répond mieux le matin.\n\n\
| Mois | Montant |\n|---|---|\n| Août | 29,99 € |\n| Septembre | 29,99 € |\n\n\
```\nidentifiant de ligne : 0000 1111 2222\n```\n";

/// An entry with every part the screen shows.
pub fn contract() -> EntryData {
    EntryData {
        read: read(around(
            entry(
                "fibre-maison",
                "Abonnement fibre de la maison",
                "contract",
                json!({
                    "aliases": ["internet"], "tags": ["maison", "abonnement"],
                    "parent_id": "maison", "verified": false,
                    "summary": "La fibre, la box et la ligne fixe de la maison.",
                    "fields": {
                        "provider": "Opérateur Lumière", "start": "2024-03-15", "renewal": "tacite",
                        "monthly_cost": "[hidden]", "customer_area": "https://example.org/espace-client",
                        "seats": 3, "paper_copy": false, "signed_by": "camille-exemple"
                    },
                    "sources": [
                        { "entry": "classeur-papiers", "slug": "classeur-papiers", "title": "Classeur des papiers", "note": "la copie signée" },
                        { "url": "https://example.org/offres/fibre" },
                        { "identifier": "doc_4412", "label": "contrat scanné" },
                        { "source": "inbox", "item": "01a1-0000-item" }
                    ],
                    "body": BODY
                }),
            ),
            json!({
                "path": ["Maison", "Abonnements"],
                "links": [
                    { "relation": "mentions", "period": null, "field": null, "id": "box-du-salon", "slug": "box-du-salon", "title": "Box du salon" },
                    { "relation": "signed_by", "period": null, "field": null, "id": "camille-exemple", "slug": "camille-exemple", "title": "Camille Exemple" }
                ],
                "backlinks": [
                    { "relation": "fulfills", "period": "2026-09", "field": "start", "id": "facture-de-septembre", "slug": "facture-de-septembre", "title": "Facture de septembre" }
                ],
                "children": [
                    { "id": "facture-de-septembre", "slug": "facture-de-septembre", "type": "invoice", "title": "Facture de septembre", "summary": "", "in_parent": false },
                    { "id": "facture-d-aout", "slug": "facture-d-aout", "type": "invoice", "title": "Facture d'août", "summary": "", "in_parent": false }
                ],
                "hidden_children": 1,
                "media": [
                    { "id": "m1", "kind": "image", "mime": "image/png", "size": 48210, "sha256": "aa11", "width": 1200, "height": 800, "duration": null, "source_url": null, "alt": "La box branchée au salon", "position": 1, "url": "/media/aa11" },
                    { "id": "m2", "kind": "pdf", "mime": "application/pdf", "size": 182044, "sha256": "bb22", "width": null, "height": null, "duration": null, "source_url": null, "alt": "", "position": 2, "url": "/media/bb22" }
                ]
            }),
        )),
        type_definition: Some(contract_type()),
    }
}

/// An entry with nothing but its title.
pub fn bare() -> EntryData {
    EntryData {
        read: read(around(
            entry("idee", "Une idée", "note", json!({})),
            json!({}),
        )),
        type_definition: None,
    }
}

/// An entry where everything is long.
pub fn long() -> EntryData {
    let paragraph = "Une phrase qui revient pour remplir la page, comme le ferait une note écrite \
        sur plusieurs mois, avec des détails, des dates et des noms de choses. ";
    let body = (1..=12)
        .map(|section| format!("## Partie {section}\n\n{}\n\n", paragraph.repeat(4)))
        .collect::<String>();
    let fields: serde_json::Map<String, Value> = (1..=24)
        .map(|index| {
            (
                format!("detail_{index:02}"),
                Value::String(paragraph.trim().to_string()),
            )
        })
        .collect();
    let children: Vec<Value> = (1..=40)
        .map(|index| json!({ "id": format!("page-{index}"), "slug": format!("page-{index}"), "type": "note", "title": format!("Page {index} du carnet de bord de la longue traversée"), "summary": "", "in_parent": false }))
        .collect();
    EntryData {
        read: read(around(
            entry(
                "carnet",
                "Carnet de bord de la longue traversée, avec un titre qui ne tient pas sur une seule ligne de l'écran",
                "journal",
                json!({ "fields": fields, "body": body, "verified": false }),
            ),
            json!({
                "path": ["Archives", "Voyages", "Traversées", "Carnets", "Deuxième série", "Volume trois"],
                "children": children
            }),
        )),
        type_definition: None,
    }
}

/// The types a search may be narrowed to.
pub fn types() -> Vec<gpui_kit::SharedString> {
    ["contract", "invoice", "note", "recipe"]
        .into_iter()
        .map(Into::into)
        .collect()
}

/// Search results with marked words.
pub fn results(count: usize) -> Vec<SearchResult> {
    let samples = [
        (
            "fibre-maison",
            "Abonnement fibre de la maison",
            "contract",
            vec!["Maison", "Abonnements"],
            "La <mark>fibre</mark> de la maison, avec la box et la ligne fixe.",
        ),
        (
            "box-du-salon",
            "Box du salon",
            "note",
            vec!["Maison"],
            "La box de la <mark>fibre</mark> est branchée derrière le meuble.",
        ),
        (
            "facture-de-septembre",
            "Facture de septembre",
            "invoice",
            vec!["Maison", "Abonnements", "Abonnement fibre de la maison"],
            "Montant de l'abonnement <mark>fibre</mark> pour septembre.",
        ),
        (
            "tarte-prunes",
            "Tarte aux prunes",
            "recipe",
            vec![],
            "Une pâte riche en <mark>fibre</mark>s, des prunes et du sucre.",
        ),
    ];
    (0..count)
        .map(|index| {
            let (slug, title, type_name, path, excerpt) = &samples[index % samples.len()];
            serde_json::from_value(json!({
                "id": format!("{slug}-{index}"), "slug": slug, "type": type_name,
                "title": if index < samples.len() { title.to_string() } else { format!("{title} ({index})") },
                "summary": "", "path": path, "excerpt": excerpt, "rank": 0.5
            }))
            .expect("a fixture result")
        })
        .collect()
}

fn node(id: &str, title: &str, type_name: &str, children: Vec<TreeNode>) -> TreeNode {
    TreeNode {
        id: id.to_string().into(),
        title: title.to_string().into(),
        type_name: type_name.to_string().into(),
        archived: false,
        children,
    }
}

/// A small vault.
pub fn tree() -> Vec<TreeNode> {
    let mut old = node(
        "ancien-contrat",
        "Ancien contrat d'électricité",
        "contract",
        vec![],
    );
    old.archived = true;
    vec![
        node(
            "maison",
            "Maison",
            "area",
            vec![
                node(
                    "abonnements",
                    "Abonnements",
                    "area",
                    vec![
                        node(
                            "fibre-maison",
                            "Abonnement fibre de la maison",
                            "contract",
                            vec![
                                node(
                                    "facture-de-septembre",
                                    "Facture de septembre",
                                    "invoice",
                                    vec![],
                                ),
                                node("facture-d-aout", "Facture d'août", "invoice", vec![]),
                            ],
                        ),
                        old,
                    ],
                ),
                node("box-du-salon", "Box du salon", "note", vec![]),
            ],
        ),
        node(
            "cuisine",
            "Cuisine",
            "area",
            vec![node("tarte-prunes", "Tarte aux prunes", "recipe", vec![])],
        ),
        node("idee", "Une idée", "note", vec![]),
    ]
}

/// A deep tree with long titles.
pub fn deep_tree() -> Vec<TreeNode> {
    let mut level = node(
        "niveau-8",
        "Niveau huit, au bout d'une très longue descente dans les dossiers",
        "note",
        vec![],
    );
    for depth in (1..8).rev() {
        let siblings = (1..=3).map(|index| {
            node(
                &format!("frere-{depth}-{index}"),
                &format!(
                    "Voisin {index} du niveau {depth}, avec un titre assez long pour être coupé"
                ),
                "note",
                vec![],
            )
        });
        let mut children = vec![level];
        children.extend(siblings);
        level = node(
            &format!("niveau-{depth}"),
            &format!("Niveau {depth}"),
            "area",
            children,
        );
    }
    let mut roots = vec![level];
    roots.extend((1..=30).map(|index| {
        node(
            &format!("racine-{index}"),
            &format!("Fiche de premier niveau numéro {index}"),
            "note",
            vec![],
        )
    }));
    roots
}
