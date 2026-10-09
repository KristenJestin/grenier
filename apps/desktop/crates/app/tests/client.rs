//! The client turns each answer of the server into data or into the problem the screens show,
//! and never shows the key.

use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

use app::client::{Client, Key};
use ui::load::Problem;

/// A server that answers one request with `status` and `body`, and gives back the request.
fn answering(status: &str, body: &str) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let address = format!("http://{}", listener.local_addr().expect("an address"));
    let (sent, received) = mpsc::channel();
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("a request");
        let mut request = [0u8; 4096];
        let read = stream.read(&mut request).expect("the request reads");
        // A test that does not look at the request has let it go.
        sent.send(String::from_utf8_lossy(&request[..read]).into_owned())
            .ok();
        stream
            .write_all(response.as_bytes())
            .expect("the answer is sent");
    });
    (address, received)
}

#[test]
fn the_tree_is_read_with_the_key_sent_as_a_bearer() {
    let (server, request) = answering(
        "200 OK",
        r#"{"entries":[{"id":"1","slug":"kitchen","type":"area","title":"Kitchen","part_of":[]}]}"#,
    );
    let tree = Client::new(server, Key::new("secret-of-test"))
        .tree()
        .expect("the tree reads");
    assert_eq!(tree[0].slug, "kitchen");
    let request = request.recv().expect("a request was made");
    assert!(request.starts_with("GET /api/entries "));
    assert!(
        request.contains("authorization: Bearer secret-of-test")
            || request.contains("Authorization: Bearer secret-of-test")
    );
}

#[test]
fn a_revoked_key_is_refused_with_the_servers_sentence() {
    let (server, _) = answering(
        "401 Unauthorized",
        r#"{"_tag":"Unauthorized","message":"This key was revoked."}"#,
    );
    match Client::new(server, Key::new("old")).tree() {
        Err(Problem::KeyRefused(sentence)) => assert_eq!(sentence, "This key was revoked."),
        other => panic!("not a refused key: {other:?}"),
    }
}

#[test]
fn an_unknown_entry_is_refused_with_the_servers_sentence() {
    let (server, request) = answering(
        "404 Not Found",
        r#"{"_tag":"NotFound","message":"The entry `nowhere` does not exist."}"#,
    );
    match Client::new(server, Key::new("k")).read("nowhere at all") {
        Err(Problem::Refused(sentence)) => {
            assert_eq!(sentence, "The entry `nowhere` does not exist.")
        }
        other => panic!("not a refusal: {other:?}"),
    }
    assert!(
        request
            .recv()
            .expect("a request")
            .starts_with("GET /api/entries/nowhere%20at%20all ")
    );
}

#[test]
fn a_server_that_does_not_answer_is_unreachable() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let server = format!("http://{}", listener.local_addr().expect("an address"));
    drop(listener);
    assert!(matches!(
        Client::new(server, Key::new("k")).tree(),
        Err(Problem::Unreachable)
    ));
}

#[test]
fn the_key_never_shows_in_what_is_printed() {
    let client = Client::new("http://127.0.0.1:1", Key::new("secret-of-test"));
    assert!(!format!("{client:?}").contains("secret-of-test"));
}
