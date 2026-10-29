# Contributing

Start with a real APK and an observable acceptance goal. Keep a new target's
scripts and a short usage/result README in `apps/<sample>/`; a standalone hook
is a valid deliverable. Extract shared capabilities when repeated use warrants it.

Use the existing guides for the task at hand:

- [Workspace README](README.md): setup, running hooks and sample entrypoints.
- [Agent guide](CLAUDE.md): working rules, ownership and acceptance boundaries.
- [Script Integration Guide](docs/SCRIPT_INTEGRATION_GUIDE.md): existing CLI,
  App packs, legacy modules and recipes when integration helps the task.
- [Testing Strategy](docs/TESTING_STRATEGY.md): checks appropriate to the change
  and the existing shared capability/CI requirements.

Report the sample identity, command, observed result and remaining limitations.
Choose verification for the changed behavior; module registration and the full
device matrix are not prerequisites for every sample or documentation change.
