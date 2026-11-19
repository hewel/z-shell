use z_shell_config::{ThemeMode, ThemeVariant};
use z_shell_theme::{ColorScheme, Hct, Rgb, TonalPalette, is_dark_at, parse_seed};

const VARIANTS: [ThemeVariant; 6] = [
    ThemeVariant::Tonal,
    ThemeVariant::Vibrant,
    ThemeVariant::Expressive,
    ThemeVariant::Fidelity,
    ThemeVariant::Neutral,
    ThemeVariant::Mono,
];

fn rgb(hex: &str) -> Rgb {
    parse_seed(hex).unwrap()
}

fn luminance(color: Rgb) -> f64 {
    fn linear(channel: u8) -> f64 {
        let value = f64::from(channel) / 255.0;
        if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    }
    0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
}

fn contrast(a: &str, b: &str) -> f64 {
    let (a, b) = (luminance(rgb(a)), luminance(rgb(b)));
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

#[test]
fn hct_matches_material_reference_colors_and_round_trips() {
    let red = Hct::from_rgb(rgb("#ff0000"));
    assert!((red.hue - 27.408).abs() < 0.01, "{red:?}");
    assert!((red.chroma - 113.358).abs() < 0.01, "{red:?}");
    assert!((red.tone - 53.237).abs() < 0.01, "{red:?}");

    let blue = Hct::from_rgb(rgb("#0000ff"));
    assert!((blue.hue - 282.788).abs() < 0.01, "{blue:?}");
    assert!((blue.chroma - 87.231).abs() < 0.01, "{blue:?}");
    assert!((blue.tone - 32.303).abs() < 0.01, "{blue:?}");

    for color in ["#6750a4", "#006e1c", "#984061", "#000000", "#ffffff"] {
        let original = rgb(color);
        let hct = Hct::from_rgb(original);
        let round_trip = hct.to_rgb();
        let recovered = Hct::from_rgb(round_trip);
        assert!(
            (recovered.tone - hct.tone).abs() < 0.2,
            "{color}: {hct:?} -> {round_trip:?}"
        );
        if original.red != original.green || original.green != original.blue {
            assert!(
                (recovered.hue - hct.hue).abs() < 0.2,
                "{color}: {hct:?} -> {round_trip:?}"
            );
        }
    }
}

#[test]
fn tonal_palette_matches_material_baseline() {
    let palette = TonalPalette::from_seed(rgb("#6750a4"), ThemeVariant::Tonal);
    assert_eq!(palette.primary.tone(40.0), "#65558f");
    assert_eq!(palette.primary.tone(80.0), "#cfbdfe");
    assert_eq!(palette.primary.tone(90.0), "#e9ddff");
    assert_eq!(palette.primary.tone(30.0), "#4d3d75");
}

#[test]
fn every_variant_and_mode_has_valid_contrasting_roles() {
    for variant in VARIANTS {
        for dark in [false, true] {
            let scheme = ColorScheme::generate(rgb("#6750a4"), variant, dark);
            assert_eq!(scheme.to_map().len(), 31, "{variant:?} dark={dark}");
            assert!(
                contrast(&scheme.primary, &scheme.on_primary) >= 4.5,
                "{variant:?} dark={dark}"
            );
            assert!(
                contrast(&scheme.surface, &scheme.on_surface) >= 4.5,
                "{variant:?} dark={dark}"
            );
            for color in scheme.to_map().values() {
                assert!(color.starts_with('#') && color.len() == 7, "{color}");
                assert!(
                    color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()),
                    "{color}"
                );
            }
        }
    }
}

#[test]
fn mono_is_grayscale_and_auto_schedule_uses_local_hour_boundaries() {
    for dark in [false, true] {
        let scheme = ColorScheme::generate(rgb("#ff0000"), ThemeVariant::Mono, dark);
        for color in scheme.to_map().values() {
            let color = rgb(color);
            assert_eq!((color.red, color.green), (color.green, color.blue));
        }
    }
    assert!(!is_dark_at(ThemeMode::Auto, 7));
    assert!(!is_dark_at(ThemeMode::Auto, 18));
    assert!(is_dark_at(ThemeMode::Auto, 19));
    assert!(is_dark_at(ThemeMode::Auto, 6));
    assert!(is_dark_at(ThemeMode::Dark, 12));
    assert!(!is_dark_at(ThemeMode::Light, 23));
}
