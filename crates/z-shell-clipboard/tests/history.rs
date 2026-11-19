use image::{DynamicImage, ImageFormat};
use std::io::Cursor;
use z_shell_clipboard::{History, Payload};
use z_shell_protocol::MediaRef;

fn text(value: &str) -> Payload {
    Payload::new("text/plain", value.as_bytes()).expect("valid text")
}

fn png(red: u8) -> Payload {
    let image = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1, 1, image::Rgb([red, 0, 0])));
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .expect("PNG encodes");
    Payload::new("image/png", output.into_inner()).expect("valid PNG")
}

#[test]
fn deduplication_moves_to_top_and_preserves_pinning() {
    let mut history = History::memory();
    let first = history.capture(text("first")).expect("capture");
    let second = history
        .capture(Payload::new("TEXT", b"second".as_slice()).expect("valid TEXT"))
        .expect("capture");
    assert!(history.pin(first));

    let duplicate = history
        .capture(Payload::new("UTF8_STRING", b"first".as_slice()).expect("valid UTF-8"))
        .expect("deduplicate");
    assert_eq!(duplicate, first);
    assert_eq!(history.entries().len(), 2);
    assert_eq!(history.entries()[0].id, first);
    assert!(history.entries()[0].pinned);
    assert_eq!(history.entries()[1].id, second);
}

#[test]
fn retention_evicts_oldest_unpinned_but_never_pinned_entries() {
    let mut history = History::memory();
    let pinned = history.capture(text("pinned")).expect("capture");
    assert!(history.pin(pinned));
    for index in 0..100 {
        history
            .capture(text(&format!("entry {index}")))
            .expect("unpinned capture");
    }
    assert_eq!(history.entries().len(), 100);
    assert_eq!(history.entries()[0].id, pinned);
    assert!(history.entries()[0].pinned);
    assert!(history.entry(pinned).is_some());

    let full = History::memory();
    let mut full = full;
    let mut ids = Vec::new();
    for index in 0..100 {
        let id = full
            .capture(text(&format!("pinned {index}")))
            .expect("capture");
        assert!(full.pin(id));
        ids.push(id);
    }
    assert!(full.capture(text("must be rejected")).is_err());
    assert!(ids.iter().all(|id| full.entry(*id).is_some()));
}

#[test]
fn image_blob_tokens_are_out_of_band_and_revoked_on_forget_and_clear() {
    let mut history = History::memory();
    let first = history.capture(png(1)).expect("capture image");
    let second = history.capture(png(2)).expect("capture image");
    let first_ref = history.media_ref(first).expect("image media ref");
    let second_ref = history.media_ref(second).expect("image media ref");
    let (first_token, second_token) = match (first_ref, second_ref) {
        (
            MediaRef::BlobHandle {
                token: first,
                mime: first_mime,
                byte_len: first_len,
            },
            MediaRef::BlobHandle { token: second, .. },
        ) => {
            assert_eq!(first_mime, "image/png");
            assert!(first_len > 0);
            (first, second)
        }
        other => panic!("unexpected media refs: {other:?}"),
    };
    let original = history
        .entry(first)
        .expect("entry")
        .payload
        .bytes()
        .to_vec();
    let blob = history.fetch_blob(&first_token).expect("blob resolves");
    assert_eq!(blob.bytes(), original);
    assert!(history.forget(first));
    assert!(history.fetch_blob(&first_token).is_none());
    assert!(history.fetch_blob(&second_token).is_some());
    history.clear();
    assert!(history.fetch_blob(&second_token).is_none());
    assert!(history.entries().is_empty());
}
