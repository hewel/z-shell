//! Short-lived isolated PAM authentication helper process.

use z_shell_session::pam::run_pam_helper;

fn main() {
    if std::env::args_os().len() != 1 {
        let outcome = z_shell_session::pam::AuthOutcome::Unavailable {
            reason: "PAM helper accepts no command-line arguments".into(),
        };
        if serde_json::to_writer(std::io::stdout(), &outcome).is_ok() {
            println!();
        }
        return;
    }
    run_pam_helper(std::io::stdin(), std::io::stdout());
}
