//! Wire and payload adapter for Fcitx's kimpanel protocol.

use std::sync::{Arc, Weak};

use serde::Serialize;
use z_shell_config::CandidateLayout;
use zbus::message::{Body, Header, Type};
use zbus::object_server::SignalEmitter;
use zbus::{Connection, Message};

use super::Ime;

pub(super) const NAME: &str = "org.kde.impanel";
pub(super) const PATH: &str = "/org/kde/impanel";
pub(super) const INPUT_METHOD: &str = "org.kde.kimpanel.inputmethod";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct ImeProperty {
    pub(super) key: String,
    pub(super) label: String,
    pub(super) icon: String,
    pub(super) text: String,
    pub(super) hints: Vec<String>,
}

impl ImeProperty {
    fn parse(raw: &str) -> Option<Self> {
        let mut fields = raw.split(':');
        let key = fields.next().filter(|key| !key.is_empty())?;
        Some(Self {
            key: key.into(),
            label: fields.next().unwrap_or_default().into(),
            icon: fields.next().unwrap_or_default().into(),
            text: fields.next().unwrap_or_default().into(),
            hints: fields
                .next()
                .filter(|hints| !hints.is_empty())
                .map_or_else(Vec::new, |hints| {
                    hints.split(',').map(str::to_owned).collect()
                }),
        })
    }
}

pub(super) enum Event {
    RegisterProperties(Vec<ImeProperty>),
    UpdateProperty(ImeProperty),
    RemoveProperty(String),
    ExecMenu(Vec<ImeProperty>),
    Enable(bool),
    Composition(Composition),
}

pub(super) enum Composition {
    Aux(String),
    Preedit(String),
    Caret(i32),
    LookupTable(LookupContent, i32, CandidateLayout),
    LegacyLookupTable(LookupContent),
    LookupCursor(i32),
    SpotRect(SpotRect),
    ShowAux(bool),
    ShowPreedit(bool),
    ShowLookupTable(bool),
}

#[derive(Debug, Default, Serialize)]
pub(super) struct Panel {
    visible: bool,
    aux: String,
    preedit: String,
    caret: i32,
    lookup_table: LookupTable,
    spot_rect: Option<SpotRect>,
    #[serde(skip)]
    layout_hint: CandidateLayout,
    #[serde(skip)]
    shown: ShowFlags,
}

#[derive(Debug, Default)]
struct ShowFlags {
    aux: bool,
    preedit: bool,
    lookup_table: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct LookupTable {
    #[serde(flatten)]
    content: LookupContent,
    cursor: i32,
    layout: CandidateLayout,
}

impl Default for LookupTable {
    fn default() -> Self {
        Self {
            content: LookupContent::default(),
            cursor: -1,
            layout: CandidateLayout::Auto,
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub(super) struct LookupContent {
    labels: Vec<String>,
    texts: Vec<String>,
    attrs: Vec<String>,
    has_prev: bool,
    has_next: bool,
}

#[derive(Debug, PartialEq, Serialize)]
pub(super) struct SpotRect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    relative: bool,
    scale: f64,
}

#[derive(PartialEq, Eq)]
enum Coordinates {
    Absolute,
    Relative,
}

impl SpotRect {
    fn new(x: i32, y: i32, w: i32, h: i32, coordinates: Coordinates, scale: f64) -> Self {
        Self {
            x,
            y,
            w,
            h,
            relative: coordinates == Coordinates::Relative,
            scale,
        }
    }
}

impl Panel {
    pub(super) fn apply(&mut self, update: Composition, preferred: CandidateLayout) -> bool {
        match update {
            Composition::Aux(aux) => replace_if_changed(&mut self.aux, aux),
            Composition::Preedit(preedit) => replace_if_changed(&mut self.preedit, preedit),
            Composition::Caret(caret) => replace_if_changed(&mut self.caret, caret),
            Composition::LookupTable(content, cursor, layout_hint) => {
                self.layout_hint = layout_hint;
                let content_changed = replace_if_changed(&mut self.lookup_table.content, content);
                let cursor_changed = replace_if_changed(&mut self.lookup_table.cursor, cursor);
                self.set_layout(preferred) || content_changed || cursor_changed
            }
            Composition::LegacyLookupTable(content) => {
                self.layout_hint = CandidateLayout::Auto;
                let content_changed = replace_if_changed(&mut self.lookup_table.content, content);
                // Legacy senders update the cursor independently.
                self.set_layout(preferred) || content_changed
            }
            Composition::LookupCursor(cursor) => {
                replace_if_changed(&mut self.lookup_table.cursor, cursor)
            }
            Composition::SpotRect(spot) => replace_if_changed(&mut self.spot_rect, Some(spot)),
            Composition::ShowAux(show) => {
                self.shown.aux = show;
                self.update_visibility()
                    | (!show && replace_if_changed(&mut self.aux, String::new()))
            }
            Composition::ShowPreedit(show) => {
                self.shown.preedit = show;
                let cleared = !show
                    && (replace_if_changed(&mut self.preedit, String::new())
                        | replace_if_changed(&mut self.caret, 0));
                self.update_visibility() | cleared
            }
            Composition::ShowLookupTable(show) => {
                self.shown.lookup_table = show;
                let cleared = !show
                    && (replace_if_changed(
                        &mut self.lookup_table.content,
                        LookupContent::default(),
                    ) | replace_if_changed(&mut self.lookup_table.cursor, -1));
                self.update_visibility() | cleared
            }
        }
    }

    fn update_visibility(&mut self) -> bool {
        let visible = self.shown.aux || self.shown.preedit || self.shown.lookup_table;
        replace_if_changed(&mut self.visible, visible)
    }

    pub(super) fn set_layout(&mut self, preferred: CandidateLayout) -> bool {
        let layout = match preferred {
            CandidateLayout::Horizontal | CandidateLayout::Vertical => preferred,
            _ => self.layout_hint,
        };
        replace_if_changed(&mut self.lookup_table.layout, layout)
    }
}

fn replace_if_changed<T: PartialEq>(current: &mut T, new: T) -> bool {
    if *current == new {
        return false;
    }
    *current = new;
    true
}

pub(super) fn parse_signal(message: &Message) -> Option<Event> {
    let header = message.header();
    if header.message_type() != Type::Signal || header.interface()?.as_str() != INPUT_METHOD {
        return None;
    }
    let body = message.body();
    let event = match header.member()?.as_str() {
        "RegisterProperties" => Event::RegisterProperties(parse_properties(&body)?),
        "UpdateProperty" => Event::UpdateProperty(ImeProperty::parse(body.deserialize().ok()?)?),
        "RemoveProperty" => Event::RemoveProperty(body.deserialize().ok()?),
        "ExecMenu" => Event::ExecMenu(parse_properties(&body)?),
        "Enable" => Event::Enable(body.deserialize().ok()?),
        member => Event::Composition(parse_composition(member, &body)?),
    };
    Some(event)
}

fn parse_properties(body: &Body) -> Option<Vec<ImeProperty>> {
    let props: Vec<&str> = body.deserialize().ok()?;
    Some(props.into_iter().filter_map(ImeProperty::parse).collect())
}

fn parse_composition(member: &str, body: &Body) -> Option<Composition> {
    Some(match member {
        "UpdateAux" | "UpdatePreeditText" => {
            let (text, _attrs): (String, &str) = body.deserialize().ok()?;
            if member == "UpdateAux" {
                Composition::Aux(text)
            } else {
                Composition::Preedit(text)
            }
        }
        "UpdatePreeditCaret" => Composition::Caret(body.deserialize().ok()?),
        "UpdateLookupTable" => Composition::LegacyLookupTable(parse_legacy_table(body)?),
        "UpdateLookupTableCursor" => Composition::LookupCursor(body.deserialize().ok()?),
        "UpdateSpotLocation" => {
            let (x, y) = body.deserialize().ok()?;
            Composition::SpotRect(SpotRect::new(x, y, 0, 0, Coordinates::Absolute, 1.0))
        }
        "ShowAux" => Composition::ShowAux(body.deserialize().ok()?),
        "ShowPreedit" => Composition::ShowPreedit(body.deserialize().ok()?),
        "ShowLookupTable" => Composition::ShowLookupTable(body.deserialize().ok()?),
        _ => return None,
    })
}

fn parse_legacy_table(body: &Body) -> Option<LookupContent> {
    // Fcitx 4 advertised two arrays but also sent attributes and paging flags.
    if let Ok((labels, texts, attrs, has_prev, has_next)) = body.deserialize() {
        return Some(LookupContent {
            labels,
            texts,
            attrs,
            has_prev,
            has_next,
        });
    }
    let (labels, texts) = body.deserialize().ok()?;
    Some(LookupContent {
        labels,
        texts,
        ..LookupContent::default()
    })
}

struct Interface;

#[zbus::interface(name = "org.kde.impanel")]
impl Interface {
    #[zbus(signal)]
    async fn panel_created(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn move_preedit_caret(emitter: &SignalEmitter<'_>, position: i32) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn select_candidate(emitter: &SignalEmitter<'_>, index: i32) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn lookup_table_page_up(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn lookup_table_page_down(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn trigger_property(emitter: &SignalEmitter<'_>, key: &str) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn reload_config(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn configure(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn exit(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;
}

struct InterfaceV2 {
    ime: Weak<Ime>,
    generation: u64,
}

impl InterfaceV2 {
    fn update(&self, header: &Header<'_>, update: Composition) {
        if let Some(sender) = header.sender()
            && let Some(ime) = self.ime.upgrade()
        {
            ime.update_panel(self.generation, sender.as_str(), update);
        }
    }
}

#[zbus::interface(name = "org.kde.impanel2")]
impl InterfaceV2 {
    #[zbus(signal)]
    async fn panel_created2(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;

    fn set_spot_rect(&self, x: i32, y: i32, w: i32, h: i32, #[zbus(header)] header: Header<'_>) {
        self.update(
            &header,
            Composition::SpotRect(SpotRect::new(x, y, w, h, Coordinates::Absolute, 1.0)),
        );
    }

    fn set_relative_spot_rect(
        &self,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        #[zbus(header)] header: Header<'_>,
    ) {
        self.update(
            &header,
            Composition::SpotRect(SpotRect::new(x, y, w, h, Coordinates::Relative, 1.0)),
        );
    }

    fn set_relative_spot_rect_v2(
        &self,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        scale: f64,
        #[zbus(header)] header: Header<'_>,
    ) {
        self.update(
            &header,
            Composition::SpotRect(SpotRect::new(x, y, w, h, Coordinates::Relative, scale)),
        );
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "fixed kimpanel SetLookupTable signature"
    )]
    fn set_lookup_table(
        &self,
        labels: Vec<String>,
        texts: Vec<String>,
        attrs: Vec<String>,
        has_prev: bool,
        has_next: bool,
        cursor: i32,
        layout: i32,
        #[zbus(header)] header: Header<'_>,
    ) {
        let layout = match layout {
            1 => CandidateLayout::Vertical,
            2 => CandidateLayout::Horizontal,
            _ => CandidateLayout::Auto,
        };
        let content = LookupContent {
            labels,
            texts,
            attrs,
            has_prev,
            has_next,
        };
        self.update(&header, Composition::LookupTable(content, cursor, layout));
    }
}

pub(super) async fn export(
    connection: &Connection,
    ime: &Arc<Ime>,
    generation: u64,
) -> zbus::Result<()> {
    let server = connection.object_server();
    server.at(PATH, Interface).await?;
    server
        .at(
            PATH,
            InterfaceV2 {
                ime: Arc::downgrade(ime),
                generation,
            },
        )
        .await?;
    Ok(())
}

pub(super) async fn announce(connection: &Connection) -> zbus::Result<()> {
    let emitter = SignalEmitter::new(connection, PATH)?;
    Interface::panel_created(&emitter).await?;
    InterfaceV2::panel_created2(&emitter).await
}
