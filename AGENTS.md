## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues (`hewel/z-shell`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at repo root). See `docs/agents/domain.md`.

### UI runtime & `zgui-js`

When editing `apps/shell/`, `plugins/*/src/`, design lints, or running local Wayland/headless previews, see `docs/agents/ui-runtime.md` and `DESIGN.md`.

### Coding standards

Judgement-call review rules live in `CODING_STANDARDS.md` (mechanical rules are enforced by `bun run lint` and `bun run typecheck`).
