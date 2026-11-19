//! sRGB, CIE XYZ, CAM16, and HCT color conversion.

use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

/// An opaque eight-bit sRGB color.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Rgb {
    /// Red channel.
    pub red: u8,
    /// Green channel.
    pub green: u8,
    /// Blue channel.
    pub blue: u8,
}

impl Rgb {
    /// Constructs an opaque sRGB color.
    #[must_use]
    pub const fn new(red: u8, green: u8, blue: u8) -> Self {
        Self { red, green, blue }
    }

    /// Formats this color as lowercase `#rrggbb`.
    #[must_use]
    pub fn to_hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.red, self.green, self.blue)
    }
}

/// Hue, chroma, and CIE L* tone in the Material HCT color space.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Hct {
    /// CAM16 hue in degrees, normalized to `0..360`.
    pub hue: f64,
    /// CAM16 chroma.
    pub chroma: f64,
    /// CIE L* perceptual lightness.
    pub tone: f64,
}

impl Hct {
    /// Constructs an HCT color without gamut mapping.
    #[must_use]
    pub const fn new(hue: f64, chroma: f64, tone: f64) -> Self {
        Self { hue, chroma, tone }
    }

    /// Converts an sRGB color to HCT under Material's standard viewing conditions.
    #[must_use]
    pub fn from_rgb(color: Rgb) -> Self {
        let xyz = xyz_from_rgb(color);
        let cam = Cam16::from_xyz(xyz);
        Self {
            hue: cam.hue,
            chroma: cam.chroma,
            tone: lstar_from_y(xyz[1]),
        }
    }

    /// Maps this HCT color into sRGB, maximizing chroma when necessary.
    #[must_use]
    pub fn to_rgb(self) -> Rgb {
        solve_to_rgb(self.hue, self.chroma, self.tone)
    }

    /// Maps this HCT color into sRGB and formats it as `#rrggbb`.
    #[must_use]
    pub fn to_hex(self) -> String {
        self.to_rgb().to_hex()
    }
}

#[derive(Debug)]
struct ViewingConditions {
    rgb_d: [f64; 3],
    aw: f64,
    nbb: f64,
    ncb: f64,
    c: f64,
    nc: f64,
    n: f64,
    fl: f64,
    z: f64,
}

impl ViewingConditions {
    fn material_default() -> Self {
        let adapting_luminance = 200.0 / PI * y_from_lstar(50.0) / 100.0;
        let r_w = 95.047 * 0.401288 + 100.0 * 0.650173 - 108.883 * 0.051461;
        let g_w = -95.047 * 0.250268 + 100.0 * 1.204414 + 108.883 * 0.045854;
        let b_w = -95.047 * 0.002079 + 100.0 * 0.048952 + 108.883 * 0.953127;
        let f = 1.0;
        let c = 0.69;
        let d =
            (f * (1.0 - (1.0 / 3.6) * ((-adapting_luminance - 42.0) / 92.0).exp())).clamp(0.0, 1.0);
        let rgb_d = [
            d * (100.0 / r_w) + 1.0 - d,
            d * (100.0 / g_w) + 1.0 - d,
            d * (100.0 / b_w) + 1.0 - d,
        ];
        let k = 1.0 / (5.0 * adapting_luminance + 1.0);
        let k4 = k.powi(4);
        let fl =
            k4 * adapting_luminance + 0.1 * (1.0 - k4).powi(2) * (5.0 * adapting_luminance).cbrt();
        let n = y_from_lstar(50.0) / 100.0;
        let z = 1.48 + n.sqrt();
        let nbb = 0.725 / n.powf(0.2);
        let rgb_a =
            [(r_w, rgb_d[0]), (g_w, rgb_d[1]), (b_w, rgb_d[2])].map(|(component, discount)| {
                let factor = (fl * discount * component / 100.0).powf(0.42);
                400.0 * factor / (factor + 27.13)
            });
        let aw = (40.0 * rgb_a[0] + 20.0 * rgb_a[1] + rgb_a[2]) / 20.0 * nbb;
        Self {
            rgb_d,
            aw,
            nbb,
            ncb: nbb,
            c,
            nc: f,
            n,
            fl,
            z,
        }
    }
}

#[derive(Debug)]
struct Cam16 {
    hue: f64,
    chroma: f64,
}

impl Cam16 {
    fn from_xyz([x, y, z]: [f64; 3]) -> Self {
        let vc = ViewingConditions::material_default();
        let r_c = 0.401288 * x + 0.650173 * y - 0.051461 * z;
        let g_c = -0.250268 * x + 1.204414 * y + 0.045854 * z;
        let b_c = -0.002079 * x + 0.048952 * y + 0.953127 * z;
        // Apply D65 adaptation before the post-adaptation nonlinear response.
        let r_d = vc.rgb_d[0] * r_c;
        let g_d = vc.rgb_d[1] * g_c;
        let b_d = vc.rgb_d[2] * b_c;
        let [r_a, g_a, b_a] = [r_d, g_d, b_d].map(|component| {
            let factor = (vc.fl * component.abs() / 100.0).powf(0.42);
            component.signum() * 400.0 * factor / (factor + 27.13)
        });
        let a = (11.0 * r_a - 12.0 * g_a + b_a) / 11.0;
        let b = (r_a + g_a - 2.0 * b_a) / 9.0;
        let u = (20.0 * r_a + 20.0 * g_a + 21.0 * b_a) / 20.0;
        let p2 = (40.0 * r_a + 20.0 * g_a + b_a) / 20.0;
        let hue = (b.atan2(a).to_degrees()).rem_euclid(360.0);
        let ac = p2 * vc.nbb;
        let j = 100.0 * (ac / vc.aw).powf(vc.c * vc.z);
        let hue_prime = if hue < 20.14 { hue + 360.0 } else { hue };
        let e_hue = 0.25 * ((hue_prime.to_radians() + 2.0).cos() + 3.8);
        let p1 = 50000.0 / 13.0 * e_hue * vc.nc * vc.ncb;
        let t = p1 * a.hypot(b) / (u + 0.305);
        let alpha = t.powf(0.9) * (1.64 - 0.29_f64.powf(vc.n)).powf(0.73);
        Self {
            hue,
            chroma: alpha * (j / 100.0).sqrt(),
        }
    }
}

fn linearized(component: u8) -> f64 {
    let normalized = f64::from(component) / 255.0;
    if normalized <= 0.040449936 {
        normalized / 12.92 * 100.0
    } else {
        ((normalized + 0.055) / 1.055).powf(2.4) * 100.0
    }
}

fn delinearized(component: f64) -> u8 {
    let normalized = component / 100.0;
    let value = if normalized <= 0.0031308 {
        normalized * 12.92
    } else {
        1.055 * normalized.powf(1.0 / 2.4) - 0.055
    };
    (value * 255.0).round().clamp(0.0, 255.0) as u8
}

fn true_delinearized(component: f64) -> f64 {
    let normalized = component / 100.0;
    let value = if normalized <= 0.0031308 {
        normalized * 12.92
    } else {
        1.055 * normalized.powf(1.0 / 2.4) - 0.055
    };
    value * 255.0
}

fn xyz_from_rgb(color: Rgb) -> [f64; 3] {
    let [r, g, b] = [color.red, color.green, color.blue].map(linearized);
    [
        0.41233895 * r + 0.35762064 * g + 0.18051042 * b,
        0.2126 * r + 0.7152 * g + 0.0722 * b,
        0.01932141 * r + 0.11916382 * g + 0.95034478 * b,
    ]
}

fn rgb_from_linrgb(linrgb: [f64; 3]) -> Rgb {
    let [red, green, blue] = linrgb.map(delinearized);
    Rgb::new(red, green, blue)
}

fn y_from_lstar(lstar: f64) -> f64 {
    100.0 * lab_inverse((lstar + 16.0) / 116.0)
}

fn lstar_from_y(y: f64) -> f64 {
    lab_forward(y / 100.0) * 116.0 - 16.0
}

fn lab_forward(t: f64) -> f64 {
    let e = 216.0 / 24389.0;
    let kappa = 24389.0 / 27.0;
    if t > e {
        t.cbrt()
    } else {
        (kappa * t + 16.0) / 116.0
    }
}

fn lab_inverse(ft: f64) -> f64 {
    let e = 216.0 / 24389.0;
    let kappa = 24389.0 / 27.0;
    let ft3 = ft * ft * ft;
    if ft3 > e {
        ft3
    } else {
        (116.0 * ft - 16.0) / kappa
    }
}

fn rgb_from_lstar(lstar: f64) -> Rgb {
    let component = delinearized(y_from_lstar(lstar));
    Rgb::new(component, component, component)
}

const SCALED_DISCOUNT_FROM_LINRGB: [[f64; 3]; 3] = [
    [
        0.001200833568784504,
        0.002389694492170889,
        0.0002795742885861124,
    ],
    [
        0.0005891086651375999,
        0.0029785502573438758,
        0.0003270666104008398,
    ],
    [
        0.00010146692491640572,
        0.0005364214359186694,
        0.0032979401770712076,
    ],
];
const LINRGB_FROM_SCALED_DISCOUNT: [[f64; 3]; 3] = [
    [1373.2198709594231, -1100.4251190754821, -7.278681089101213],
    [-271.815969077903, 559.6580465940733, -32.46047482791194],
    [1.9622899599665666, -57.173814538844006, 308.7233197812385],
];
const Y_FROM_LINRGB: [f64; 3] = [0.2126, 0.7152, 0.0722];

fn matrix_multiply(row: [f64; 3], matrix: &[[f64; 3]; 3]) -> [f64; 3] {
    [
        row[0] * matrix[0][0] + row[1] * matrix[0][1] + row[2] * matrix[0][2],
        row[0] * matrix[1][0] + row[1] * matrix[1][1] + row[2] * matrix[1][2],
        row[0] * matrix[2][0] + row[1] * matrix[2][1] + row[2] * matrix[2][2],
    ]
}

fn chromatic_adaptation(component: f64) -> f64 {
    let factor = component.abs().powf(0.42);
    component.signum() * 400.0 * factor / (factor + 27.13)
}

fn inverse_chromatic_adaptation(component: f64) -> f64 {
    let base = (27.13 * component.abs() / (400.0 - component.abs())).max(0.0);
    component.signum() * base.powf(1.0 / 0.42)
}

fn hue_of(linrgb: [f64; 3]) -> f64 {
    let [r, g, b] = matrix_multiply(linrgb, &SCALED_DISCOUNT_FROM_LINRGB).map(chromatic_adaptation);
    let a = (11.0 * r - 12.0 * g + b) / 11.0;
    let b = (r + g - 2.0 * b) / 9.0;
    b.atan2(a)
}

fn sanitize_radians(angle: f64) -> f64 {
    (angle + PI * 8.0).rem_euclid(PI * 2.0)
}

fn in_cyclic_order(a: f64, b: f64, c: f64) -> bool {
    sanitize_radians(b - a) < sanitize_radians(c - a)
}

fn nth_vertex(y: f64, n: usize) -> Option<[f64; 3]> {
    let coord_a = if n % 4 <= 1 { 0.0 } else { 100.0 };
    let coord_b = if n.is_multiple_of(2) { 0.0 } else { 100.0 };
    let vertex = if n < 4 {
        let [g, b] = [coord_a, coord_b];
        [
            (y - g * Y_FROM_LINRGB[1] - b * Y_FROM_LINRGB[2]) / Y_FROM_LINRGB[0],
            g,
            b,
        ]
    } else if n < 8 {
        let [b, r] = [coord_a, coord_b];
        [
            r,
            (y - r * Y_FROM_LINRGB[0] - b * Y_FROM_LINRGB[2]) / Y_FROM_LINRGB[1],
            b,
        ]
    } else {
        let [r, g] = [coord_a, coord_b];
        [
            r,
            g,
            (y - r * Y_FROM_LINRGB[0] - g * Y_FROM_LINRGB[1]) / Y_FROM_LINRGB[2],
        ]
    };
    vertex
        .into_iter()
        .all(|component| (0.0..=100.0).contains(&component))
        .then_some(vertex)
}

fn bisect_to_segment(y: f64, target_hue: f64) -> [[f64; 3]; 2] {
    let mut left = [-1.0; 3];
    let mut right = left;
    let mut left_hue = 0.0;
    let mut right_hue = 0.0;
    let mut initialized = false;
    let mut uncut = true;
    for n in 0..12 {
        let Some(mid) = nth_vertex(y, n) else {
            continue;
        };
        let mid_hue = hue_of(mid);
        if !initialized {
            left = mid;
            right = mid;
            left_hue = mid_hue;
            right_hue = mid_hue;
            initialized = true;
            continue;
        }
        if uncut || in_cyclic_order(left_hue, mid_hue, right_hue) {
            uncut = false;
            if in_cyclic_order(left_hue, target_hue, mid_hue) {
                right = mid;
                right_hue = mid_hue;
            } else {
                left = mid;
                left_hue = mid_hue;
            }
        }
    }
    assert!(
        initialized,
        "a valid luminance plane intersects the RGB cube: y={y}"
    );
    [left, right]
}

fn midpoint(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        (a[0] + b[0]) / 2.0,
        (a[1] + b[1]) / 2.0,
        (a[2] + b[2]) / 2.0,
    ]
}

fn critical_plane(index: i32) -> f64 {
    let normalized = (f64::from(index) + 0.5) / 255.0;
    if normalized <= 0.040449936 {
        normalized / 12.92 * 100.0
    } else {
        ((normalized + 0.055) / 1.055).powf(2.4) * 100.0
    }
}

fn set_coordinate(source: [f64; 3], coordinate: f64, target: [f64; 3], axis: usize) -> [f64; 3] {
    let t = (coordinate - source[axis]) / (target[axis] - source[axis]);
    let mut result = source;
    for axis in 0..3 {
        result[axis] = source[axis] + (target[axis] - source[axis]) * t;
    }
    result
}

fn bisect_to_limit(y: f64, target_hue: f64) -> [f64; 3] {
    let [mut left, mut right] = bisect_to_segment(y, target_hue);
    let mut left_hue = hue_of(left);
    for axis in 0..3 {
        if left[axis] != right[axis] {
            let (mut left_plane, mut right_plane) = if left[axis] < right[axis] {
                (
                    (true_delinearized(left[axis]) - 0.5).floor() as i32,
                    (true_delinearized(right[axis]) - 0.5).ceil() as i32,
                )
            } else {
                (
                    (true_delinearized(left[axis]) - 0.5).ceil() as i32,
                    (true_delinearized(right[axis]) - 0.5).floor() as i32,
                )
            };
            for _ in 0..8 {
                if (right_plane - left_plane).abs() <= 1 {
                    break;
                }
                let mid_plane = (left_plane + right_plane).div_euclid(2);
                let mid = set_coordinate(left, critical_plane(mid_plane), right, axis);
                let mid_hue = hue_of(mid);
                if in_cyclic_order(left_hue, target_hue, mid_hue) {
                    right = mid;
                    right_plane = mid_plane;
                } else {
                    left = mid;
                    left_hue = mid_hue;
                    left_plane = mid_plane;
                }
            }
        }
    }
    midpoint(left, right)
}

fn find_result_by_j(hue_radians: f64, chroma: f64, y: f64) -> Option<Rgb> {
    let mut j = y.sqrt() * 11.0;
    let vc = ViewingConditions::material_default();
    let t_inner = 1.0 / (1.64 - 0.29_f64.powf(vc.n)).powf(0.73);
    let e_hue = 0.25 * ((hue_radians + 2.0).cos() + 3.8);
    let p1 = e_hue * (50000.0 / 13.0) * vc.nc * vc.ncb;
    let h_sin = hue_radians.sin();
    let h_cos = hue_radians.cos();
    for iteration in 0..5 {
        let j_normalized = j / 100.0;
        let alpha = if chroma == 0.0 || j == 0.0 {
            0.0
        } else {
            chroma / j_normalized.sqrt()
        };
        let t = (alpha * t_inner).powf(1.0 / 0.9);
        let ac = vc.aw * j_normalized.powf(1.0 / vc.c / vc.z);
        let p2 = ac / vc.nbb;
        let gamma = 23.0 * (p2 + 0.305) * t / (23.0 * p1 + 11.0 * t * h_cos + 108.0 * t * h_sin);
        let a = gamma * h_cos;
        let b = gamma * h_sin;
        let r_a = (460.0 * p2 + 451.0 * a + 288.0 * b) / 1403.0;
        let g_a = (460.0 * p2 - 891.0 * a - 261.0 * b) / 1403.0;
        let b_a = (460.0 * p2 - 220.0 * a - 6300.0 * b) / 1403.0;
        let linrgb = matrix_multiply(
            [r_a, g_a, b_a].map(inverse_chromatic_adaptation),
            &LINRGB_FROM_SCALED_DISCOUNT,
        );
        if linrgb.into_iter().any(|component| component < 0.0) {
            return None;
        }
        let fnj = Y_FROM_LINRGB[0] * linrgb[0]
            + Y_FROM_LINRGB[1] * linrgb[1]
            + Y_FROM_LINRGB[2] * linrgb[2];
        if fnj <= 0.0 {
            return None;
        }
        if iteration == 4 || (fnj - y).abs() < 0.002 {
            if linrgb.into_iter().any(|component| component > 100.01) {
                return None;
            }
            return Some(rgb_from_linrgb(linrgb));
        }
        j -= (fnj - y) * j / (2.0 * fnj);
    }
    None
}

fn solve_to_rgb(hue: f64, chroma: f64, tone: f64) -> Rgb {
    if chroma < 0.0001 || tone < 0.0001 || tone > 99.9999 {
        return rgb_from_lstar(tone);
    }
    let hue = hue.rem_euclid(360.0).to_radians();
    let y = y_from_lstar(tone);
    find_result_by_j(hue, chroma, y).unwrap_or_else(|| rgb_from_linrgb(bisect_to_limit(y, hue)))
}
