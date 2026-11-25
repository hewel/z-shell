//! Validated HTTPS / localhost-HTTP fetches with explicit redirect checking.

use std::time::Duration;

use ureq::Agent;
use ureq::http::{Response, StatusCode};

const MAX_REDIRECT_HOPS: usize = 5;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Validates that a remote URL uses `https://` or an explicit localhost development port.
pub(crate) fn validate_remote_url(url: &str) -> Result<(), String> {
    if url.starts_with("https://")
        || url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://[::1]:")
        || url.starts_with("http://localhost:")
    {
        return Ok(());
    }
    Err("remote URLs must use https://".to_owned())
}

/// Validates redirect target rules: initial `https://` URLs must stay `https://` on redirect to
/// prevent downgrade or localhost SSRF via remote 30x responses.
fn validate_redirect_target(initial_is_https: bool, location: &str) -> Result<(), String> {
    if initial_is_https {
        if location.starts_with("https://") {
            return Ok(());
        }
        return Err("https:// remote URLs may only redirect to https:// destinations".to_owned());
    }
    validate_remote_url(location)
}

/// Performs an HTTP GET request while re-validating every redirect target against [`validate_remote_url`].
pub(crate) fn get_validated(
    url: &str,
    if_none_match: Option<&str>,
) -> Result<Response<ureq::Body>, String> {
    validate_remote_url(url)?;
    let initial_is_https = url.starts_with("https://");
    let agent = Agent::config_builder()
        .max_redirects(0)
        .timeout_global(Some(HTTP_TIMEOUT))
        .build()
        .new_agent();

    let mut current = url.to_owned();
    for _ in 0..=MAX_REDIRECT_HOPS {
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
    use super::validate_redirect_target;

    #[test]
    fn https_redirect_rejects_http_and_localhost_downgrade() {
        assert!(validate_redirect_target(true, "https://cdn.example.org/a.tar.gz").is_ok());
        assert!(validate_redirect_target(true, "http://example.com/a.tar.gz").is_err());
        assert!(validate_redirect_target(true, "http://127.0.0.1:8080/secret").is_err());
        assert!(validate_redirect_target(true, "http://localhost:8080/secret").is_err());
        assert!(validate_redirect_target(false, "http://127.0.0.1:8080/local.tar.gz").is_ok());
    }
}
