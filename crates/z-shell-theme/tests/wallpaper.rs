use image::{DynamicImage, ImageBuffer, Rgb as ImageRgb};
use std::io::Cursor;
use z_shell_config::ThemeVariant;
use z_shell_theme::{ColorScheme, dominant_color};

fn png(pixel: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
    let image = ImageBuffer::from_fn(96, 96, |x, y| ImageRgb(pixel(x, y)));
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

#[test]
fn extracts_representative_chromatic_png_seed_and_generates_palette() {
    let bytes = png(|x, _| {
        if x < 60 {
            [128, 128, 128]
        } else {
            [229, 56, 53]
        }
    });
    let seed = dominant_color(&bytes).unwrap();
    assert_eq!(seed.to_hex(), "#e53835");
    let scheme = ColorScheme::generate(seed, ThemeVariant::Vibrant, true);
    assert_eq!(scheme.to_map().len(), 31);
    assert_ne!(scheme.primary, scheme.surface);
}

#[test]
fn monochrome_wallpaper_still_has_deterministic_seed() {
    let bytes = png(|x, y| {
        if (x + y) % 5 == 0 {
            [245, 245, 245]
        } else {
            [32, 32, 32]
        }
    });
    let seed = dominant_color(&bytes).unwrap();
    assert_eq!(seed.to_hex(), "#202020");
}
