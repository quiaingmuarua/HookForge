# AgentForge macOS ARM64 integration

The dedicated runner remains registered with AgentForge; it is not a HookForge
runner and is not triggered by ordinary HookForge commits. It builds AgentForge's
current ARM64 detect-env and uses its fixed HookForge submodule commit.

Operations, isolated paths, trusted triggers and cleanup are owned by
[AgentForge macOS runner operations](https://github.com/quiaingmuarua/AgentForge/blob/main/docs/FRIDA_MACOS_RUNNER.md).

HookForge's independent baseline is Ubuntu API33 x86_64. See [CI](CI.md).
