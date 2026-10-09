//! Invented data for the stories: no real person, place, amount or document.

use api::{EntryProvenanceValue, EntryRead, LinkProvenance, SearchResult, TypeDefinition};
use serde_json::{Value, json};
use ui::entry::EntryData;
use ui::load::Load;
use ui::viewer::TreeNode;

fn read(value: Value) -> EntryRead {
    serde_json::from_value(value).expect("a fixture entry reads as the API returns it")
}

fn entry(id: &str, title: &str, type_name: &str, extra: Value) -> Value {
    let mut base = json!({
        "id": id, "type": type_name, "title": title, "slug": id,
        "aliases": [], "tags": [], "parent_id": null, "fields": {}, "provenance": {},
        "sources": [], "body": "", "summary": "",
        "created": "2026-09-01T08:00:00.000Z", "updated": "2026-10-01T08:00:00.000Z",
        "valid_from": null, "valid_until": null, "superseded_by": null, "archived_at": null, "archived_reason": null
    });
    if let (Value::Object(base), Value::Object(extra)) = (&mut base, extra) {
        base.extend(extra);
    }
    base
}

fn around(entry: Value, extra: Value) -> Value {
    let mut base = json!({
        "entry": entry, "path": [], "ancestors": [], "references": [], "links": [], "media": [], "backlinks": [],
        "children": [], "hidden_children": 0, "cited_by": [], "titles": {}
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
                    "parent_id": "maison",
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
                "ancestors": [{ "id": "maison", "title": "Maison" }, { "id": "abonnements", "title": "Abonnements" }],
                "references": [
                    { "reference": "box-du-salon", "id": "box-du-salon", "title": "Box du salon" },
                    { "reference": "facture-de-septembre", "id": "facture-de-septembre", "title": "Facture de septembre" }
                ],
                "links": [
                    { "relation": "mentions", "provenance": "extracted", "period": null, "field": null, "note": null, "valid_from": null, "valid_until": null, "id": "box-du-salon", "slug": "box-du-salon", "title": "Box du salon" },
                    { "relation": "signed_by", "provenance": "extracted", "period": null, "field": null, "note": null, "valid_from": null, "valid_until": null, "id": "camille-exemple", "slug": "camille-exemple", "title": "Camille Exemple" }
                ],
                "backlinks": [
                    { "relation": "fulfills", "provenance": "extracted", "period": "2026-09", "field": "start", "note": null, "valid_from": null, "valid_until": null, "id": "facture-de-septembre", "slug": "facture-de-septembre", "title": "Facture de septembre" }
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
        history: Load::Empty,
        more_history: false,
    }
}

fn item_type() -> TypeDefinition {
    serde_json::from_value(json!({
        "name": "item", "label": "Objet", "description": "Un objet possédé, ou une de ses pièces.",
        "read_in_parent": true,
        "fields": [
            { "name": "serial", "kind": "text" },
            { "name": "capacity", "kind": "text" },
            { "name": "warranty_until", "kind": "date" },
            { "name": "price", "kind": "money", "sensitive": true },
            { "name": "bought_with", "kind": "entry" }
        ]
    }))
    .expect("a fixture type")
}

/// The same contract as a writer left it when it was not sure of everything: the summary, the
/// body, the renewal and a link only supposed, the customer area on which sources disagree, the
/// provider known, and the seats written before writers were asked, which carry no mark.
pub fn supposed() -> EntryData {
    let mut data = contract();
    data.read.entry.provenance = [
        ("provider", EntryProvenanceValue::Extracted),
        ("renewal", EntryProvenanceValue::Inferred),
        ("customer_area", EntryProvenanceValue::Ambiguous),
        ("seats", EntryProvenanceValue::Unstated),
        ("summary", EntryProvenanceValue::Inferred),
        ("body", EntryProvenanceValue::Inferred),
    ]
    .into_iter()
    .map(|(name, provenance)| (name.to_string(), provenance))
    .collect();
    for link in &mut data.read.links {
        if link.relation == "signed_by" {
            link.provenance = LinkProvenance::Inferred;
        }
    }
    data
}

/// A machine and its parts, one of them with a value the key may not see; and a note beside them.
pub fn machine() -> EntryData {
    let part = |id: &str, title: &str, fields: Value| json!({ "id": id, "slug": id, "type": "item", "title": title, "summary": "", "in_parent": true, "fields": fields });
    // A part with the titles of the entries its fields name, as the server gives them.
    let titled = |mut part: Value, titles: Value| {
        part["titles"] = titles;
        part
    };
    EntryData {
        read: read(around(
            entry(
                "ordinateur-du-bureau",
                "Ordinateur du bureau",
                "item",
                json!({
                    "summary": "La tour du bureau, montée en 2025.",
                    "fields": { "serial": "TOUR-0042", "warranty_until": "2028-02-01" }
                }),
            ),
            json!({
                "path": ["Maison", "Bureau"],
                "ancestors": [{ "id": "maison", "title": "Maison" }, { "id": "bureau", "title": "Bureau" }],
                "children": [
                    part("alimentation", "Alimentation", json!({})),
                    part("carte-graphique", "Carte graphique", json!({ "serial": "GPU-7781", "warranty_until": "2027-11-30" })),
                    part("disque-de-sauvegarde", "Disque de sauvegarde", json!({ "serial": "HDD-5512", "capacity": "4 To", "price": "[hidden]" })),
                    titled(
                        part("disque-principal", "Disque principal", json!({ "serial": "SSD-0193", "capacity": "1 To", "warranty_until": "2029-06-15", "bought_with": "facture-du-disque" })),
                        json!({ "facture-du-disque": "Facture du disque" })
                    ),
                    { "id": "notes-de-montage", "slug": "notes-de-montage", "type": "note", "title": "Notes de montage", "summary": "L'ordre des câbles et les vis à garder.", "in_parent": false }
                ]
            }),
        )),
        type_definition: Some(item_type()),
        history: Load::Empty,
        more_history: false,
    }
}

fn person_type() -> TypeDefinition {
    serde_json::from_value(json!({
        "name": "person", "label": "Personne", "description": "Quelqu'un que l'on connaît.",
        "fields": [
            { "name": "employer", "kind": "entry", "types": ["organization"] },
            { "name": "bought_from", "kind": "entry", "types": ["organization"], "many": true },
            { "name": "languages", "kind": "text", "many": true },
            { "name": "interests", "kind": "enum", "values": ["vélo", "jardin", "cuisine"], "many": true },
            { "name": "codes", "kind": "text", "many": true, "sensitive": true }
        ]
    }))
    .expect("a fixture type")
}

/// A person tied to organizations: repeated values, entries among them, and links that say a
/// role and the dates they held between.
pub fn person() -> EntryData {
    let link = |relation: &str, id: &str, title: &str, note: Value, from: Value, until: Value| {
        json!({ "relation": relation, "provenance": "extracted", "period": null, "field": null, "note": note,
                "valid_from": from, "valid_until": until, "id": id, "slug": id, "title": title })
    };
    EntryData {
        read: read(around(
            entry(
                "camille-exemple",
                "Camille Exemple",
                "person",
                json!({
                    "summary": "Une amie de longue date, comptable.",
                    "fields": {
                        "employer": "atelier-des-lampes",
                        "bought_from": ["boutique-du-coin", "atelier-des-lampes", "marche-couvert"],
                        "languages": ["français", "gallois", "basque"],
                        "interests": ["vélo", "jardin"],
                        "codes": "[hidden]"
                    }
                }),
            ),
            json!({
                "path": ["Proches"],
                "ancestors": [{ "id": "proches", "title": "Proches" }],
                "titles": {
                    "atelier-des-lampes": "Atelier des lampes",
                    "boutique-du-coin": "Boutique du coin",
                    "marche-couvert": "Marché couvert"
                },
                "links": [
                    link("works_at", "atelier-des-lampes", "Atelier des lampes", json!("comptable"), json!("2024-01-01"), Value::Null),
                    link("worked_at", "boutique-du-coin", "Boutique du coin", json!("vendeuse"), json!("2019-09-01"), json!("2023-12-31")),
                    link("bought_from", "marche-couvert", "Marché couvert", json!("une lampe de bureau"), Value::Null, Value::Null)
                ],
                "backlinks": [
                    link("signed_by", "fibre-maison", "Abonnement fibre de la maison", Value::Null, Value::Null, json!("2026-03-15"))
                ]
            }),
        )),
        type_definition: Some(person_type()),
        history: Load::Empty,
        more_history: false,
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
        history: Load::Empty,
        more_history: false,
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
                json!({ "fields": fields, "body": body }),
            ),
            json!({
                "path": ["Archives", "Voyages", "Traversées", "Carnets", "Deuxième série", "Volume trois"],
                "ancestors": [{ "id": "archives", "title": "Archives" }, { "id": "voyages", "title": "Voyages" }, { "id": "traversees", "title": "Traversées" }, { "id": "carnets", "title": "Carnets" }, { "id": "deuxieme-serie", "title": "Deuxième série" }, { "id": "volume-trois", "title": "Volume trois" }],
                "children": children
            }),
        )),
        type_definition: None,
        history: Load::Empty,
        more_history: false,
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

fn project_type() -> TypeDefinition {
    serde_json::from_value(json!({
        "name": "project", "label": "Projet", "description": "Un projet, avec ce qui en dépend.",
        "fields": [
            { "name": "owner", "kind": "entry", "types": ["person"] },
            { "name": "hosts", "kind": "entry", "many": true }
        ]
    }))
    .expect("a fixture type")
}

/// A link of a fixture, as the API returns it.
fn a_link(relation: &str, id: &str, title: &str, note: Value, from: Value) -> Value {
    json!({ "relation": relation, "provenance": "extracted", "period": null, "field": null, "note": note,
            "valid_from": from, "valid_until": null, "id": id, "slug": id, "title": title })
}

/// A project at the heart of an instance: 160 links, of every kind, and fields naming entries.
pub fn many_links() -> EntryData {
    let mut links: Vec<Value> = vec![
        a_link(
            "uses",
            "serveur-atlas",
            "Serveur Atlas",
            json!("hébergement principal"),
            json!("2025-02-01"),
        ),
        a_link(
            "uses",
            "serveur-borée",
            "Serveur Borée",
            json!("sauvegardes"),
            Value::Null,
        ),
        a_link(
            "depends_on",
            "registre-de-noms",
            "Registre de noms",
            Value::Null,
            Value::Null,
        ),
        a_link(
            "depends_on",
            "certificats",
            "Certificats du domaine",
            json!("renouvelés chaque année"),
            Value::Null,
        ),
    ];
    links.extend((1..=6).map(|n| {
        a_link(
            "mentions",
            &format!("note-{n}"),
            &format!("Note de chantier {n}"),
            Value::Null,
            Value::Null,
        )
    }));
    let mut backlinks: Vec<Value> = (1..=30)
        .map(|n| {
            a_link(
                "part_of",
                &format!("tache-{n:02}"),
                &format!("Tâche {n:02} du projet Phare"),
                Value::Null,
                Value::Null,
            )
        })
        .collect();
    backlinks.extend((1..=120).map(|n| {
        a_link(
            "mentions",
            &format!("journal-{n:03}"),
            &format!("Journal du {n:03}e jour"),
            Value::Null,
            Value::Null,
        )
    }));
    EntryData {
        read: read(around(
            entry(
                "phare",
                "Phare",
                "project",
                json!({
                    "summary": "Le projet qui relie tout le reste.",
                    "tags": ["projet", "infrastructure"],
                    "fields": { "owner": "camille-exemple", "hosts": ["serveur-atlas", "serveur-borée"] }
                }),
            ),
            json!({
                "links": links,
                "backlinks": backlinks,
                "titles": {
                    "camille-exemple": "Camille Exemple",
                    "serveur-atlas": "Serveur Atlas",
                    "serveur-borée": "Serveur Borée"
                }
            }),
        )),
        type_definition: Some(project_type()),
        history: Load::Empty,
        more_history: false,
    }
}

/// Folders of about 200 entries, seven of them sharing a long beginning with their parent's title.
pub fn long_titles_tree() -> Vec<TreeNode> {
    let contracts = node(
        "contrats-entretien",
        "Contrats d'entretien du Phare",
        "area",
        [
            "fibre du bureau",
            "hébergement des serveurs",
            "noms de domaine",
            "certificats",
            "sauvegardes hors site",
            "téléphonie",
            "maintenance des onduleurs",
        ]
        .into_iter()
        .enumerate()
        .map(|(n, rest)| {
            node(
                &format!("contrat-technique-{n}"),
                &format!("Contrats d'entretien du Phare — {rest}"),
                "contract",
                vec![],
            )
        })
        .collect(),
    );
    let tasks = node(
        "taches",
        "Tâches",
        "area",
        (1..=30)
            .map(|n| {
                node(
                    &format!("tache-{n:02}"),
                    &format!("Tâche {n:02} du projet Phare"),
                    "note",
                    vec![],
                )
            })
            .collect(),
    );
    let journal = node(
        "journal",
        "Journal",
        "area",
        (1..=150)
            .map(|n| {
                node(
                    &format!("journal-{n:03}"),
                    &format!("Journal du {n:03}e jour"),
                    "note",
                    vec![],
                )
            })
            .collect(),
    );
    vec![
        node("phare", "Phare", "project", vec![contracts, tasks]),
        node("archives-phare", "Archives", "area", vec![journal]),
    ]
}

/// The entries of a type with a tag, as a chip of an entry lists them.
pub fn listed() -> ui::list::ListData {
    let entries = [
        ("fibre-maison", "Abonnement fibre de la maison"),
        ("assurance-habitation", "Assurance habitation"),
        ("electricite", "Contrat d'électricité"),
        ("eau", "Contrat d'eau"),
        ("entretien-chaudiere", "Entretien de la chaudière"),
        ("gaz", "Contrat de gaz"),
    ]
    .into_iter()
    .map(|(id, title)| {
        serde_json::from_value(json!({
            "id": id, "slug": id, "type": "contract", "title": title,
            "parent_id": null, "in_parent": false
        }))
        .expect("a fixture listing")
    })
    .collect();
    ui::list::ListData {
        filter: ui::intent::ListFilter {
            type_name: Some(("contract".into(), "Contrat".into())),
            tag: Some("maison".into()),
            supposed: false,
        },
        type_labels: [("contract".to_string(), "Contrat".to_string())].into(),
        entries: Load::Ready(entries),
        more: false,
    }
}

/// The contract with its history shown: newest first, a long body as an excerpt, older ones to come.
pub fn with_history() -> EntryData {
    let event = |id: &str, at: &str, actor: &str, action: &str, changes: Value| {
        serde_json::from_value(
            json!({ "id": id, "at": at, "actor": actor, "action": action, "changes": changes }),
        )
        .expect("a fixture event")
    };
    EntryData {
        history: Load::Ready(vec![
            event(
                "41",
                "2026-10-07T09:12:00.000Z",
                "agent-portable",
                "update",
                json!([
                    { "field": "fields.provider", "before": "Opérateur Lumière", "after": "Opérateur Lumière Pro" },
                    { "field": "summary", "before": "La fibre de la maison.", "after": "La fibre, la box et la ligne fixe de la maison." }
                ]),
            ),
            event(
                "37",
                "2026-10-03T18:40:00.000Z",
                "agent-portable",
                "link",
                json!([
                    { "field": "links.signed_by", "before": null, "after": "camille-exemple" }
                ]),
            ),
            event(
                "22",
                "2026-09-14T07:05:00.000Z",
                "agent-bureau",
                "update",
                json!([
                    { "field": "body", "before": { "size": 812, "excerpt": "## Ce que couvre le contrat\n\nLa fibre de la maison, avec la box…" },
                      "after": { "size": 1024, "excerpt": "## Ce que couvre le contrat\n\nLa fibre de la maison, avec la box et la ligne fixe…" } },
                    { "field": "tags", "before": ["maison"], "after": ["maison", "abonnement"] },
                    { "field": "fields.renewal", "before": "manuel", "after": "tacite" },
                    { "field": "fields.start", "before": null, "after": "2024-03-15" }
                ]),
            ),
            event(
                "3",
                "2026-09-01T08:00:00.000Z",
                "agent-bureau",
                "create",
                json!([
                    { "field": "title", "before": null, "after": "Abonnement fibre de la maison" }
                ]),
            ),
        ]),
        more_history: true,
        ..bare()
    }
}
