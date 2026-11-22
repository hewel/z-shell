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
    const SEEDS: [&str; 10] = [
        "#6750a4", "#A6C8FF", "#D0BCFF", "#7DD3FC", "#86EFAC", "#FCD34D", "#FCA5A5", "#ff0000",
        "#000000", "#ffffff",
    ];
    for seed in SEEDS {
        for variant in VARIANTS {
            for dark in [false, true] {
                let scheme = ColorScheme::generate(rgb(seed), variant, dark);
                assert_eq!(scheme.to_map().len(), 31, "{seed} {variant:?} dark={dark}");

                // WCAG 2.2 SC 1.4.3: normal text role pairs must meet >= 4.5:1.
                let text_pairs = [
                    ("on_primary / primary", &scheme.on_primary, &scheme.primary),
                    (
                        "on_primary_container / primary_container",
                        &scheme.on_primary_container,
                        &scheme.primary_container,
                    ),
                    (
                        "on_secondary / secondary",
                        &scheme.on_secondary,
                        &scheme.secondary,
                    ),
                    (
                        "on_secondary_container / secondary_container",
                        &scheme.on_secondary_container,
                        &scheme.secondary_container,
                    ),
                    (
                        "on_tertiary / tertiary",
                        &scheme.on_tertiary,
                        &scheme.tertiary,
                    ),
                    (
                        "on_tertiary_container / tertiary_container",
                        &scheme.on_tertiary_container,
                        &scheme.tertiary_container,
                    ),
                    ("on_error / error", &scheme.on_error, &scheme.error),
                    (
                        "on_error_container / error_container",
                        &scheme.on_error_container,
                        &scheme.error_container,
                    ),
                    (
                        "inverse_on_surface / inverse_surface",
                        &scheme.inverse_on_surface,
                        &scheme.inverse_surface,
                    ),
                    ("on_surface / surface", &scheme.on_surface, &scheme.surface),
                    (
                        "on_surface / surface_dim",
                        &scheme.on_surface,
                        &scheme.surface_dim,
                    ),
                    (
                        "on_surface / surface_bright",
                        &scheme.on_surface,
                        &scheme.surface_bright,
                    ),
                    (
                        "on_surface / surface_container_lowest",
                        &scheme.on_surface,
                        &scheme.surface_container_lowest,
                    ),
                    (
                        "on_surface / surface_container_low",
                        &scheme.on_surface,
                        &scheme.surface_container_low,
                    ),
                    (
                        "on_surface / surface_container",
                        &scheme.on_surface,
                        &scheme.surface_container,
                    ),
                    (
                        "on_surface / surface_container_high",
                        &scheme.on_surface,
                        &scheme.surface_container_high,
                    ),
                    (
                        "on_surface / surface_container_highest",
                        &scheme.on_surface,
                        &scheme.surface_container_highest,
                    ),
                    (
                        "on_surface_variant / surface",
                        &scheme.on_surface_variant,
                        &scheme.surface,
                    ),
                    (
                        "on_surface_variant / surface_dim",
                        &scheme.on_surface_variant,
                        &scheme.surface_dim,
                    ),
                    (
                        "on_surface_variant / surface_bright",
                        &scheme.on_surface_variant,
                        &scheme.surface_bright,
                    ),
                    (
                        "on_surface_variant / surface_container_lowest",
                        &scheme.on_surface_variant,
                        &scheme.surface_container_lowest,
                    ),
                    (
                        "on_surface_variant / surface_container_low",
                        &scheme.on_surface_variant,
                        &scheme.surface_container_low,
                    ),
                    (
                        "on_surface_variant / surface_container",
                        &scheme.on_surface_variant,
                        &scheme.surface_container,
                    ),
                    (
                        "on_surface_variant / surface_container_high",
                        &scheme.on_surface_variant,
                        &scheme.surface_container_high,
                    ),
                    (
                        "on_surface_variant / surface_container_highest",
                        &scheme.on_surface_variant,
                        &scheme.surface_container_highest,
                    ),
                ];
                for (pair, fg, bg) in text_pairs {
                    let ratio = contrast(fg, bg);
                    assert!(
                        ratio >= 4.5,
                        "WCAG SC 1.4.3 failed for {pair} ({fg} on {bg}) = {ratio:.2}:1 (seed={seed}, variant={variant:?}, dark={dark})"
                    );
                }

                // WCAG 2.2 SC 1.4.11: non-text UI accents and control borders must meet >= 3.0:1.
                let ui_pairs = [
                    (
                        "primary / surface_container",
                        &scheme.primary,
                        &scheme.surface_container,
                    ),
                    (
                        "primary / surface_container_high",
                        &scheme.primary,
                        &scheme.surface_container_high,
                    ),
                    (
                        "error / surface_container",
                        &scheme.error,
                        &scheme.surface_container,
                    ),
                    (
                        "outline / surface_container",
                        &scheme.outline,
                        &scheme.surface_container,
                    ),
                ];
                for (pair, fg, bg) in ui_pairs {
                    let ratio = contrast(fg, bg);
                    assert!(
                        ratio >= 3.0,
                        "WCAG SC 1.4.11 failed for {pair} ({fg} on {bg}) = {ratio:.2}:1 (seed={seed}, variant={variant:?}, dark={dark})"
                    );
                }

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

#[test]
fn light_mode_reference_matches_design_md_hierarchy_and_contrast() {
    let light = ColorScheme::generate(rgb("#1976D2"), ThemeVariant::Tonal, false);
    assert_eq!(light.to_map().len(), 31);
    assert_eq!(light.on_primary, "#ffffff");

    // Light Mode surface plane steps down gently in luminance from surface -> surface-container-highest.
    let l_surface = luminance(rgb(&light.surface));
    let l_container = luminance(rgb(&light.surface_container));
    let l_high = luminance(rgb(&light.surface_container_high));
    let l_highest = luminance(rgb(&light.surface_container_highest));
    assert!(
        l_surface > l_container && l_container > l_high && l_high > l_highest && l_highest > 0.7,
        "Light Mode neutral surface ramp out of order: surface={} ({l_surface:.3}), container={} ({l_container:.3}), high={} ({l_high:.3}), highest={} ({l_highest:.3})",
        light.surface,
        light.surface_container,
        light.surface_container_high,
        light.surface_container_highest
    );

    // Primary and error accents stay dark/legible against light surfaces, while containers stay calm and light.
    assert!(contrast(&light.primary, &light.surface_container) >= 4.5);
    assert!(contrast(&light.on_primary_container, &light.primary_container) >= 4.5);
    assert!(contrast(&light.on_secondary_container, &light.secondary_container) >= 4.5);
    assert!(contrast(&light.on_error_container, &light.error_container) >= 4.5);
    assert!(luminance(rgb(&light.primary_container)) > 0.65);
    assert!(luminance(rgb(&light.on_surface)) < 0.05);
}
