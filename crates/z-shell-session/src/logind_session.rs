//! Shared `systemd-logind` session path and concrete `Session.Id` resolution.

use zbus::Connection;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

pub(crate) const LOGIND_NAME: &str = "org.freedesktop.login1";
pub(crate) const LOGIND_PATH: &str = "/org/freedesktop/login1";
pub(crate) const LOGIND_MANAGER: &str = "org.freedesktop.login1.Manager";
pub(crate) const LOGIND_SESSION: &str = "org.freedesktop.login1.Session";
const AUTO_SESSION_PATH: &str = "/org/freedesktop/login1/session/auto";
const DBUS_PROPERTIES: &str = "org.freedesktop.DBus.Properties";

/// Resolves the concrete `systemd-logind` session object path for the current daemon.
///
/// Prefers `GetSessionByPID`, then `XDG_SESSION_ID` (excluding literal `"auto"`), and finally
/// `GetSession("auto")` / `/org/freedesktop/login1/session/auto` verified against `geteuid()`.
pub(crate) async fn resolve_session_path(connection: &Connection) -> Option<OwnedObjectPath> {
    if let Ok(path) = call_manager_path(connection, "GetSessionByPID", &(std::process::id(),)).await
        && path.as_str() != AUTO_SESSION_PATH
    {
        return Some(path);
    }
    if let Some(expected_uid) = crate::passwd::effective_uid()
        && let Ok(session_id) = std::env::var("XDG_SESSION_ID")
    {
        let trimmed = session_id.trim();
        if !trimmed.is_empty()
            && trimmed != "auto"
            && let Ok(path) = call_manager_path(connection, "GetSession", &(trimmed,)).await
            && path.as_str() != AUTO_SESSION_PATH
            && read_session_uid(connection, &path).await == Ok(expected_uid)
        {
            return Some(path);
        }
    }
    let (concrete_path, _) = resolve_verified_auto_session(connection).await.ok()?;
    Some(concrete_path)
}

/// Resolves the concrete `Session.Id` string for Polkit Authority registration.
///
/// Never returns empty strings or literal `"auto"`.
pub(crate) async fn resolve_session_id(connection: &Connection) -> Result<String, zbus::Error> {
    if let Ok(path) = call_manager_path(connection, "GetSessionByPID", &(std::process::id(),)).await
        && path.as_str() != AUTO_SESSION_PATH
    {
        let id = read_session_id(connection, &path).await?;
        if !id.is_empty() && id != "auto" {
            return Ok(id);
        }
    }
    let (_, id) = resolve_verified_auto_session(connection).await?;
    Ok(id)
}

async fn resolve_verified_auto_session(
    connection: &Connection,
) -> Result<(OwnedObjectPath, String), zbus::Error> {
    let expected_uid = crate::passwd::effective_uid().ok_or_else(|| {
        zbus::Error::Failure("effective UID unavailable for auto session verification".into())
    })?;
    let candidate = match call_manager_path(connection, "GetSession", &("auto",)).await {
        Ok(path) => path,
        Err(_) => OwnedObjectPath::try_from(AUTO_SESSION_PATH).map_err(zbus::Error::from)?,
    };
    let session_uid = read_session_uid(connection, &candidate).await?;
    if session_uid != expected_uid {
        return Err(zbus::Error::Failure(format!(
            "logind auto session uid {session_uid} does not match daemon uid {expected_uid}"
        )));
    }
    let id = read_session_id(connection, &candidate).await?;
    if id.is_empty() || id == "auto" {
        return Err(zbus::Error::Failure(
            "logind returned an empty or non-concrete session ID".into(),
        ));
    }
    let concrete_path = if candidate.as_str() == AUTO_SESSION_PATH {
        let resolved = call_manager_path(connection, "GetSession", &(id.as_str(),)).await?;
        if resolved.as_str() == AUTO_SESSION_PATH {
            return Err(zbus::Error::Failure(
                "logind GetSession resolved back to /session/auto".into(),
            ));
        }
        resolved
    } else {
        candidate
    };
    Ok((concrete_path, id))
}

async fn call_manager_path<B: serde::ser::Serialize + zbus::zvariant::DynamicType>(
    connection: &Connection,
    method: &str,
    body: &B,
) -> Result<OwnedObjectPath, zbus::Error> {
    connection
        .call_method(
            Some(LOGIND_NAME),
            LOGIND_PATH,
            Some(LOGIND_MANAGER),
            method,
            body,
        )
        .await?
        .body()
        .deserialize()
}

async fn read_session_id(
    connection: &Connection,
    session_path: &OwnedObjectPath,
) -> Result<String, zbus::Error> {
    let raw: OwnedValue = connection
        .call_method(
            Some(LOGIND_NAME),
            session_path,
            Some(DBUS_PROPERTIES),
            "Get",
            &(LOGIND_SESSION, "Id"),
        )
        .await?
        .body()
        .deserialize()?;
    String::try_from(raw).map_err(zbus::Error::from)
}

async fn read_session_uid(
    connection: &Connection,
    session_path: &OwnedObjectPath,
) -> Result<u32, zbus::Error> {
    let raw: OwnedValue = connection
        .call_method(
            Some(LOGIND_NAME),
            session_path,
            Some(DBUS_PROPERTIES),
            "Get",
            &(LOGIND_SESSION, "User"),
        )
        .await?
        .body()
        .deserialize()?;
    let uid = match &*raw {
        Value::Structure(structure) => structure
            .fields()
            .first()
            .and_then(|field| u32::try_from(field).ok()),
        Value::U32(uid) => Some(*uid),
        _ => None,
    };
    uid.ok_or_else(|| zbus::Error::Failure("invalid logind Session.User property".into()))
}
