# Vendored office-engine source

- Upstream project: https://github.com/p10node/office-engine
- Upstream tag: `v0.18.0`
- Exact upstream commit: `d7126505a00a431529d479c11d8d3372aeaf6cd0`
- License: MIT (see [LICENSE](./LICENSE))
- Source location: [src](./src)

GitNotes vendors the complete runtime source tree from the upstream release so the application does not depend on the author's npm package or repository being available at build or runtime.

The source is maintained as part of GitNotes. Changes made here do not modify the upstream project. When importing a future upstream change, review it against GitNotes' requirements, inspect its dependency and license changes, and update this provenance record deliberately.

The engine has no runtime dependencies other than React and React DOM peer dependencies, which are supplied by the host GitNotes application. Its build-time tooling is not required by GitNotes because Vite compiles the vendored TypeScript source as part of the application.
