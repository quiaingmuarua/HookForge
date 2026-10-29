# HookForge agent guide

Read `README.md`, `CLAUDE.md`, then the nearest sample or owner needed for the task.

- Start from a real APK and the user's requested outcome. Own analysis, hooks,
  execution and troubleshooting through to a reproducible result or concrete blocker.
- New target scripts and a short usage/result README belong in `apps/<sample>/`.
  Standalone scripts and target-specific hooks are valid; registration is optional.
- Record sample identity, command, environment, actual effect and limits. A loaded
  script or API hit alone does not prove the requested App behavior.
- Extract public capabilities from repeated real use. Do not build orchestration
  or analysis frameworks before working sample solutions.
- Follow the shared detection intervention contract in `CLAUDE.md` when claiming
  reusable behavior; label target-specific mechanisms accurately.
- Keep APKs, AARs, downloaded tools and real traffic out of Git. Local external
  inputs use `third_party_readonly/`; cache, builds and evidence use `.runtime/`.
- Preserve unrelated changes. Edit TypeScript hosts and regenerate checked-in
  development JavaScript with `npm run build:hosts`.
- Use Windows Git Bash and native Windows tools locally; do not use WSL.
- HookForge evolves independently. AgentForge pins an explicit submodule commit
  and upgrades when needed; do not automatically change the consumer repository.

Run checks appropriate to changed behavior. Shared CI uses `npm run test:ci`
and `npm run build:prod`; sample changes need actual target execution. See
`docs/CI.md` for fixed APK fixtures and the separate AgentForge integrations.
