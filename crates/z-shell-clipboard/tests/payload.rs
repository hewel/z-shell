use image::{DynamicImage, ImageFormat};
use std::io::Cursor;
use z_shell_clipboard::{
    MAX_IMAGE_BYTES, MAX_TEXT_BYTES, Payload, PayloadKind, choose_mime, offer_is_sensitive,
};

fn encoded_image(format: ImageFormat) -> Vec<u8> {
    let mut output = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(2, 3)
        .write_to(&mut output, format)
        .expect("test image encodes");
    output.into_inner()
}

#[test]
fn mime_priority_is_independent_of_offer_order() {
    let offers = vec![
        "STRING".to_owned(),
        "image/png".to_owned(),
        "text/plain".to_owned(),
        "text/plain;charset=utf-8".to_owned(),
    ];
    assert_eq!(
        choose_mime(&offers).as_deref(),
        Some("text/plain;charset=utf-8")
    );
}

#[test]
fn latin1_bytes_and_label_are_preserved() {
    let payload =
        Payload::new("STRING", &[0x63, 0x61, 0x66, 0xe9][..]).expect("Latin-1 is valid text");
    assert_eq!(payload.kind(), PayloadKind::Text);
    assert_eq!(payload.bytes(), &[0x63, 0x61, 0x66, 0xe9]);
    assert_eq!(payload.text_preview(20), "café");
    assert_eq!(payload.copy_mimes(), vec!["STRING"]);
    assert!(payload.matches_query("CAFÉ"));
}

#[test]
fn non_ascii_utf8_never_advertises_legacy_or_latin1_aliases() {
    let payload = Payload::new("UTF8_STRING", "日本語".as_bytes()).expect("valid UTF-8");
    let mimes = payload.copy_mimes();
    assert!(mimes.contains(&"text/plain;charset=utf-8".to_owned()));
    assert!(!mimes.contains(&"TEXT".to_owned()));
    assert!(!mimes.contains(&"STRING".to_owned()));
}

#[test]
fn blank_invalid_and_oversized_payloads_are_rejected() {
    for mime in ["text/plain", "TEXT", "STRING"] {
        assert!(
            Payload::new(mime, b" \t\r\n".as_slice()).is_err(),
            "mime {mime}"
        );
    }
    assert!(Payload::new("text/plain", [0xff].as_slice()).is_err());
    assert!(Payload::new("text/plain", vec![b'x'; MAX_TEXT_BYTES + 1]).is_err());
    assert!(Payload::new("image/png", vec![0; MAX_IMAGE_BYTES + 1]).is_err());
    assert!(Payload::new("application/octet-stream", b"data".as_slice()).is_err());
}

#[test]
fn valid_image_dimensions_are_read_with_decode_limits() {
    let bytes = encoded_image(ImageFormat::Png);
    let payload = Payload::new("image/png", bytes).expect("valid PNG");
    assert_eq!(payload.kind(), PayloadKind::Image);
    let dimensions = payload.dimensions().expect("image dimensions");
    assert_eq!((dimensions.width, dimensions.height), (2, 3));
    assert!(Payload::new("image/png", b"not a png".as_slice()).is_err());
}

#[test]
fn password_manager_hint_rejects_the_whole_offer() {
    assert!(offer_is_sensitive(&[
        "text/plain".to_owned(),
        "x-kde-passwordManagerHint".to_owned(),
    ]));
    assert!(!offer_is_sensitive(&["text/plain".to_owned()]));
}
