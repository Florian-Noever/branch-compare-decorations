# Changelog

All notable changes to **Branch Compare** are documented in this file.

---

## [0.1.0] – Unreleased

### Added

- Unit and integration tests; the integration tests run against real Git repositories inside a VS Code instance
- GitHub Actions: on a published release, run the tests, package the extension and attach the `.vsix`, then publish it to the Visual Studio Marketplace and Open VSX
- Tooltips name the base ref of the file's own repository, e.g. "Changes vs origin/main" or "Changes since this branch was created"

### Changed

- Publisher is now `Florian-Noever` (extension ID `Florian-Noever.branch-compare`); the `branchCompare.*` settings carry over
- The extension is bundled with **esbuild** into a single `out/extension.js`; `tsc` is only used for type-checking
- Commands are grouped under the **Branch Compare** category
- The base branch picker lists the branches of all remotes (the upstream's remote first), and manual entry accepts any branch, tag or commit
- Decorations are no longer recomputed on every file save; **Refresh Decorations** forces a full recomputation
- Requires VS Code 1.105 or later

### Fixed

- In workspaces with several repositories, every repository was compared against the base ref of the active editor's repository, and without an active editor nothing was decorated
- **Set Base Branch** saved the base ref for the wrong branch when another repository was picked, and failed with a `TypeError` when no repository was active
- Folders were decorated when a changed file merely started with their name (`src/foo` for `src/foobar.ts`)
- A broken base ref in one repository removed the decorations of all repositories and caused an error on every refresh
- **Current Branch Origin** failed for branches without upstream, and on `develop` compared against `origin/develop` itself
- **Main Development Branch** and the picker assumed the remote is called `origin`
- Base refs of local branches containing a slash (`feature/x`) triggered a failing fetch on every refresh
- Activation failed while Git is disabled (`git.enabled: false`)
- Event listeners and timers were never disposed
- Tooltips showed the internal values `__branch_origin__` / `__main_origin__`

---

## [0.0.2] – 2025-09-26

### Changed

- Limited concurrent Git work, fetch cooldown and faster change detection
- Folders containing changes are decorated
- Improved logging

---

## [0.0.1] – 2025-09-05

### Added

- First development release
