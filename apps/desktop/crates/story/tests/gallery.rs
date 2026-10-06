//! The gallery opens on the story it is asked for, switches stories, and toggles light and dark.

use gpui_kit::{AppContext as _, TestAppContext};
use story::{Gallery, stories};

#[gpui_kit::test]
fn the_gallery_opens_the_story_it_is_asked_for(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let last = stories().last().expect("there are stories").name;
    let first = stories()[0].name;
    let (named, cx) = cx.add_window_view(|window, cx| Gallery::new(Some(last), window, cx));
    named.read_with(cx, |gallery, _| assert_eq!(gallery.shown(), last));
    let unknown =
        cx.update(|window, cx| cx.new(|cx| Gallery::new(Some("no/such-story"), window, cx)));
    unknown.read_with(cx, |gallery, _| assert_eq!(gallery.shown(), first));
}

#[gpui_kit::test]
fn every_story_opens(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        ui::viewer::init(cx);
    });
    let (gallery, cx) = cx.add_window_view(|window, cx| Gallery::new(None, window, cx));
    for story in stories() {
        cx.update(|window, cx| {
            gallery.update(cx, |gallery, cx| gallery.show(story.name, window, cx))
        });
        cx.run_until_parked();
        gallery.read_with(cx, |gallery, _| assert_eq!(gallery.shown(), story.name));
    }
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
