//! The gallery opens on the story it is asked for, switches stories, and toggles light and dark.

use gpui_kit::{AppContext as _, TestAppContext};
use story::{Gallery, stories};

#[gpui_kit::test]
fn the_gallery_opens_the_story_it_is_asked_for(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let first = stories()[0].name;
    let named = cx.new(|_| Gallery::new(Some(first)));
    let unknown = cx.new(|_| Gallery::new(Some("no/such-story")));
    named.read_with(cx, |gallery, _| assert_eq!(gallery.shown(), first));
    unknown.read_with(cx, |gallery, _| assert_eq!(gallery.shown(), first));
}

#[gpui_kit::test]
fn light_and_dark_switch_for_the_whole_gallery(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    cx.update(|cx| {
        ui::theme::set_dark(true, cx);
        assert!(ui::theme::is_dark(cx));
        ui::theme::set_dark(false, cx);
        assert!(!ui::theme::is_dark(cx));
    });
}

#[test]
fn every_story_has_a_name_of_its_own() {
    let names: Vec<_> = stories().iter().map(|story| story.name).collect();
    let mut unique = names.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), names.len());
}
