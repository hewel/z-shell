//! Validated HTTPS / localhost-HTTP fetches with resolved-IP SSRF checks, redirect validation,
//! and cooperative offline cancellation.

use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ureq::Agent;
use ureq::http::{Response, StatusCode, Uri};
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};

const MAX_REDIRECT_HOPS: usize = 5;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Cooperative cancellation handle that aborts in-flight HTTP requests immediately.
#[derive(Debug, Default)]
pub struct CancelToken {
    cancelled: AtomicBool,
    active_agents: Mutex<Vec<Agent>>,
}

impl CancelToken {
    /// Creates a new uncancelled token.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Marks the token cancelled and shuts down any registered active HTTP agents.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.active_agents.lock() {
            for agent in guard.drain(..) {
                agent.shutdown();
            }
        }
    }

    /// Resets the cancellation state (used when returning to online mode).
    pub fn reset(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }

    /// Returns true if cancellation was requested.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn register_agent(&self, agent: Agent) {
        if let Ok(mut guard) = self.active_agents.lock() {
            if self.is_cancelled() {
                agent.shutdown();
            } else {
                guard.push(agent);
            }
        }
    }

    fn clear_agents(&self) {
        if let Ok(mut guard) = self.active_agents.lock() {
            guard.clear();
        }
    }
}

/// Returns true if `ip` is loopback, private, link-local, multicast, unspecified, broadcast,
/// CGNAT, or documentation/reserved and therefore unsafe for remote HTTPS fetches.
#[must_use]
pub fn is_forbidden_remote_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_ipv4(v4),
        IpAddr::V6(v6) => is_forbidden_ipv6(v6),
    }
}

const fn is_forbidden_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    let is_cgnat = octets[0] == 100 && (octets[1] & 0b1100_0000) == 64;
    let is_benchmarking = octets[0] == 198 && (octets[1] & 0b1111_1110) == 18;
    let is_ietf_protocol = octets[0] == 192 && octets[1] == 0 && octets[2] == 0;
    let is_reserved_high = octets[0] >= 240;

    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || ip.is_documentation()
        || is_cgnat
        || is_benchmarking
        || is_ietf_protocol
        || is_reserved_high
}

const fn is_forbidden_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_forbidden_ipv4(mapped);
    }
    let segs = ip.segments();
    let is_documentation = segs[0] == 0x2001 && segs[1] == 0x0db8;
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || is_documentation
}

/// Returns true when `url` is an explicit localhost HTTP development endpoint.
#[must_use]
pub fn is_explicit_localhost_http(url: &str) -> bool {
    url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://[::1]:")
        || url.starts_with("http://localhost:")
}

/// Validates that a remote URL uses `https://` or an explicit localhost development port.
///
/// # Errors
///
/// Returns an error description if the URL scheme is unsupported or contains control chars.
pub fn validate_remote_url(url: &str) -> Result<(), String> {
    if url.trim().is_empty() || url.chars().any(char::is_control) {
        return Err("remote URL must be non-empty without control characters".to_owned());
    }
    if url.starts_with("https://") || is_explicit_localhost_http(url) {
        return Ok(());
    }
    Err("remote URLs must use https://".to_owned())
}

/// Validates redirect target rules: initial `https://` URLs must stay `https://` on redirect to
/// prevent downgrade or localhost SSRF via remote 30x responses.
pub(crate) fn validate_redirect_target(
    initial_is_https: bool,
    location: &str,
) -> Result<(), String> {
    if initial_is_https {
        if location.starts_with("https://") {
            return Ok(());
        }
        return Err("https:// remote URLs may only redirect to https:// destinations".to_owned());
    }
    validate_remote_url(location)
}

#[derive(Debug)]
struct SsrfSafeResolver {
    allow_localhost_http: bool,
    cancel: Option<Arc<CancelToken>>,
    inner: DefaultResolver,
}

impl SsrfSafeResolver {
    fn new(allow_localhost_http: bool, cancel: Option<Arc<CancelToken>>) -> Self {
        Self {
            allow_localhost_http,
            cancel,
            inner: DefaultResolver::default(),
        }
    }
}

impl Resolver for SsrfSafeResolver {
    fn resolve(
        &self,
        uri: &Uri,
        config: &ureq::config::Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        if self
            .cancel
            .as_ref()
            .is_some_and(|token| token.is_cancelled())
        {
            return Err(ureq::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "remote fetch cancelled",
            )));
        }
        let scheme = uri.scheme_str().unwrap_or("");
        if scheme != "https" && !(self.allow_localhost_http && scheme == "http") {
            return Err(ureq::Error::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "blocked disallowed URL scheme",
            )));
        }

        let resolved = self.inner.resolve(uri, config, timeout)?;
        if self.allow_localhost_http && scheme == "http" {
            let all_loopback = !resolved.is_empty()
                && resolved
                    .iter()
                    .all(|addr: &SocketAddr| addr.ip().is_loopback());
            if !all_loopback {
                return Err(ureq::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "localhost http URL resolved to non-loopback address",
                )));
            }
            return Ok(resolved);
        }

        for addr in &resolved {
            if is_forbidden_remote_ip(addr.ip()) {
                return Err(ureq::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!("blocked SSRF target IP {}", addr.ip()),
                )));
            }
        }
        Ok(resolved)
    }
}

/// Performs an HTTP GET request while re-validating every redirect target and resolved IP address.
pub(crate) fn get_validated(
    url: &str,
    if_none_match: Option<&str>,
) -> Result<Response<ureq::Body>, String> {
    get_validated_cancellable(url, if_none_match, None)
}

/// Performs a cancellable, SSRF-validated HTTP GET request across all redirect hops.
pub(crate) fn get_validated_cancellable(
    url: &str,
    if_none_match: Option<&str>,
    cancel: Option<&Arc<CancelToken>>,
) -> Result<Response<ureq::Body>, String> {
    if cancel.is_some_and(|token| token.is_cancelled()) {
        return Err("remote fetch cancelled".to_owned());
    }
    validate_remote_url(url)?;
    let initial_is_https = url.starts_with("https://");
    let allow_localhost_http = !initial_is_https && is_explicit_localhost_http(url);
    let config = Agent::config_builder()
        .max_redirects(0)
        .timeout_global(Some(HTTP_TIMEOUT))
        .build();
    let resolver = SsrfSafeResolver::new(allow_localhost_http, cancel.cloned());
    let agent = Agent::with_parts(config, DefaultConnector::default(), resolver);
    if let Some(token) = cancel {
        token.register_agent(agent.clone());
    }

    let result = (|| {
        let mut current = url.to_owned();
        for _ in 0..=MAX_REDIRECT_HOPS {
            if cancel.is_some_and(|token| token.is_cancelled()) {
                return Err("remote fetch cancelled".to_owned());
            }
            let mut req = agent.get(&current);
            if let Some(etag) = if_none_match {
                req = req.header("If-None-Match", etag);
            }
            let resp = req.call().map_err(|err| err.to_string())?;
            if is_redirect(resp.status()) {
                let location = resp
                    .headers()
                    .get("Location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| "redirect response missing valid Location header".to_owned())?;
                validate_redirect_target(initial_is_https, location)?;
                current = location.to_owned();
                continue;
            }
            return Ok(resp);
        }
        Err(format!(
            "exceeded maximum redirect hops ({MAX_REDIRECT_HOPS})"
        ))
    })();

    if result.is_err()
        && let Some(token) = cancel
    {
        token.clear_agents();
    }
    result
}

/// Reads at most `max_bytes` from an HTTP response body while checking cooperative cancellation.
pub(crate) fn read_body_bounded(
    resp: Response<ureq::Body>,
    max_bytes: usize,
    cancel: Option<&Arc<CancelToken>>,
) -> Result<Vec<u8>, String> {
    if let Some(len) = resp
        .headers()
        .get("Content-Length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        && len > max_bytes as u64
    {
        return Err(format!("remote payload exceeds {max_bytes} byte budget"));
    }

    let mut reader = resp.into_body().into_reader();
    let mut out = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        if cancel.is_some_and(|token| token.is_cancelled()) {
            return Err("remote fetch cancelled".to_owned());
        }
        let n = reader.read(&mut buf).map_err(|err| err.to_string())?;
        if n == 0 {
            break;
        }
        if out.len().saturating_add(n) > max_bytes {
            return Err(format!("remote payload exceeds {max_bytes} byte budget"));
        }
        out.extend_from_slice(&buf[..n]);
    }
    if let Some(token) = cancel {
        token.clear_agents();
    }
    Ok(out)
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn https_redirect_rejects_http_and_localhost_downgrade() {
        assert!(validate_redirect_target(true, "https://cdn.example.org/a.tar.gz").is_ok());
        assert!(validate_redirect_target(true, "http://example.com/a.tar.gz").is_err());
        assert!(validate_redirect_target(true, "http://127.0.0.1:8080/secret").is_err());
        assert!(validate_redirect_target(true, "http://localhost:8080/secret").is_err());
        assert!(validate_redirect_target(false, "http://127.0.0.1:8080/local.tar.gz").is_ok());
    }

    #[test]
    fn blocks_private_loopback_link_local_cgnat_and_v4_mapped_ips() {
        for forbidden in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.5.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
        ] {
            let ip: IpAddr = forbidden.parse().unwrap();
            assert!(is_forbidden_remote_ip(ip), "expected {ip} to be forbidden");
        }
        for allowed in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"] {
            let ip: IpAddr = allowed.parse().unwrap();
            assert!(!is_forbidden_remote_ip(ip), "expected {ip} to be allowed");
        }
    }

    #[test]
    fn https_fetch_rejects_loopback_ip_and_localhost_redirect_to_external_ip() {
        // Direct https:// to loopback must be blocked by SSRF resolver before connecting.
        let err = get_validated("https://127.0.0.1:8443/catalog.json", None).unwrap_err();
        assert!(
            err.contains("SSRF") || err.contains("PermissionDenied") || err.contains("blocked"),
            "{err}"
        );

        // Redirect from localhost HTTP to an https:// loopback address must also be blocked.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut req = [0u8; 512];
                let _ = stream.read(&mut req);
                let _ = stream.write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1:9999/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        let err = get_validated(&format!("http://{addr}/redirect"), None).unwrap_err();
        server.join().unwrap();
        assert!(
            err.contains("SSRF") || err.contains("blocked") || err.contains("PermissionDenied"),
            "{err}"
        );
    }

    #[test]
    fn cancel_token_aborts_in_flight_remote_fetch() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut req = [0u8; 512];
                let _ = stream.read(&mut req);
                let _ = tx.send(());
                // Hold the socket open without sending headers until client shuts down.
                thread::sleep(Duration::from_millis(500));
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            }
        });

        let token = Arc::new(CancelToken::new());
        let token_clone = Arc::clone(&token);
        let url = format!("http://{addr}/slow.json");
        let client_handle =
            thread::spawn(move || get_validated_cancellable(&url, None, Some(&token_clone)));

        rx.recv().unwrap();
        token.cancel();
        let res = client_handle.join().unwrap();
        server.join().unwrap();
        assert!(res.is_err());
    }
}
