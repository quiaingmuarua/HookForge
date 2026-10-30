# Contributing

Start with a real APK and an observable acceptance goal. Follow the
[work loop and Git rules](AGENTS.md): evaluate existing tools first, implement
for actual gaps, and judge results on the target. Reproducible use of an
existing tool is a complete contribution without new HookForge code.

Routine, scoped changes go directly to `main`; major changes use a branch and
PR. Preserve existing work and branch choices instead of creating a branch
for every task.

Keep private/project-specific scripts in the consuming project. Public
integration examples and their usage/result READMEs belong in `apps/<sample>/`.
Shared code should save repeated work or cover a well-understood common
operation. Using a third-party project does not require adding an adapter.

Use the existing guides for the task at hand:

- [Workspace README](README.md): setup, running hooks and sample entrypoints.
- [Working guide](AGENTS.md): tool selection, ownership and acceptance boundaries.
- [Script Integration Guide](docs/SCRIPT_INTEGRATION_GUIDE.md): existing CLI,
  App packs, legacy modules and recipes when integration helps the task.
- [Testing Strategy](docs/TESTING_STRATEGY.md): checks appropriate to the change
  and the existing shared capability/CI requirements.

Report the sample identity, command, observed result and remaining limitations.
Choose verification for the changed behavior; module registration and the full
device matrix are not prerequisites for every sample or documentation change.
