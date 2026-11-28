# Vendored office-engine source

- Upstream project: https://github.com/p10node/office-engine
- Upstream tag: `v0.18.0`
- Exact upstream commit: `d7126505a00a431529d479c11d8d3372aeaf6cd0`
- License: MIT (see [LICENSE](./LICENSE))
- Source location: [src](./src)

GitNote vendors the runtime TypeScript source required by its Office and HTML integrations. The application imports this source directly and Vite compiles it as part of GitNote. The upstream npm package is not a dependency; neither the build nor application runtime needs the upstream GitHub repository, npm registry or a network connection to obtain the engine.

## Update policy

Updates are selective, manual and reviewed. Do not track upstream `HEAD` automatically, add an npm/Git dependency, replace the source with a tarball, or import the upstream repository wholesale.

When an update is justified by a relevant bug fix, security fix or capability GitNote needs:

1. Review the upstream release/commit and identify the exact source changes required.
2. Import only the relevant runtime source files. Do not bring in unrelated server-side conversion services (`packages/convert`), Docker configuration, playgrounds, examples, upstream tests or build tooling unless a separately approved GitNote requirement needs them.
3. Review API changes, runtime/build dependencies and license changes. Keep the upstream MIT license and attribution with the vendored code.
4. Preserve GitNote-specific integration and format adapters under `src/modules/documents`.
5. Update the pinned tag and exact commit above, then run unit tests, the production TypeScript/Vite build and Chromium workflows covering DOCX, XLSX, PPTX and HTML.
6. Consider the update complete only after all required CI jobs pass on the resulting `main` commit.

GitNote does not maintain an automatic fork-sync or subtree workflow. The repository's vendored source is the code actually built and shipped; upstream is only a reviewed source for future changes.

The engine's runtime peer requirements are React and React DOM, which are supplied by the host GitNote application. Upstream build-time tooling is not required by GitNote.
