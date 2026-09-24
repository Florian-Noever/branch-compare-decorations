# Branch Compare - Copilot Instructions

## Project Overview

**Branch Compare** is a VS Code extension (publisher: `Florian-Noever`) that decorates the files a branch changed compared to a configurable base ref. It uses the badges (`A`/`M`/`D`/`R`) and theme colors of the built-in Git decorations and reads everything through the built-in Git extension's API (`vscode.git`, API version 1).

The base ref is configured **per branch name** in the `branchCompare.baseRefs` setting (user settings) via the **Set Base Branch** command. Every open repository is compared against the base ref of its own current branch.

```
branch-compare/
├── src/                 # VS Code extension (TypeScript, bundled with esbuild)
│   └── test/            # Mocha unit + integration tests (VS Code extension host)
└── .github/             # CI: build/test/package on release, publish to Marketplace + Open VSX
```

---

## Key Files

| File | Role |
|------|------|
| `extension.ts` | Activation: `Logger.initialize`, gets the Git API once, creates provider + picker, registers commands |
| `constants.ts` | **Single source of truth**: `MANIFEST` (package.json), command IDs, config keys, special refs, timings and limits |
| `handlers/setBaseBranch.ts` | Set Base Branch: select repository → pick ref → save under that repository's branch → refresh |
| `handlers/refreshDecorations.ts` | Refresh Decorations: resets the baseline cache and refreshes |
| `utils/branchCompareProvider.ts` | `BranchCompareProvider` — `FileDecorationProvider` + `Disposable`; computes changes per repository, owns all caches and subscriptions |
| `utils/baselineResolver.ts` | Special ref resolution, same-branch detection, latest fork point from main branches, tooltip text |
| `utils/gitUtils.ts` | `getGitApi`, git CLI calls (`merge-base --fork-point`, commit timestamps), remote/main-branch helpers, `parseRemoteRef` |
| `utils/gitBranchPicker.ts` | `GitBranchPicker` — repository and base ref quick picks |
| `utils/baseRefUtils.ts` | Read/write `branchCompare.baseRefs` |
| `utils/changeCategory.ts` | Git `Status` → category → badge + `gitDecoration.*` color |
| `utils/pathUtils.ts` | `normalizeFsPath` (case-insensitive on Windows), `isPathInside`, `getAncestorDirs` |
| `utils/logger.ts` | `Logger` static class wrapping a `vscode.LogOutputChannel` |
| `utils/errors.ts` | `errorMessage(e: unknown)` |
| `types/git.ts` | Vendored Git extension API typings from microsoft/vscode — **keep verbatim** (a `.ts` file only so esbuild can emit its `const enum`s; excluded from ESLint) |
| `types/changeCategory.ts` | `ChangeCategory`, `GitDecorationColorKey` |

---

## How Decorations Are Computed

```
refresh()                                   (debounced from repository state / config events)
  → for every open repository (max 3 in parallel, failures contained per repository)
    → branch = HEAD.name                    (detached HEAD → skipped)
    → configured ref = baseRefs[branch]     (empty → skipped)
    → resolveSpecialBaseRef                 (__branch_origin__ → upstream or the branch itself,
                                             __main_origin__  → first existing main branch)
    → autoFetch                             (only refs of a configured remote, 30 s cooldown)
    → baseline                              (cached per repository, keyed by HEAD commit, branch,
                                             base ref and upstream; Refresh Decorations resets it)
        same branch/upstream → latest fork point from the other main branches
        otherwise            → merge-base --fork-point, falling back to merge-base
    → repository.diffBetween(baseline, 'HEAD')   (baseline...HEAD, statuses A/D/M/R)
  → changedFiles + changedDirs (ancestor folders, bounded by workspace folders and repository roots)
  → onDidChangeFileDecorations fires only for paths whose decoration changed (> 500 → everything)
```

- **Special refs**: `__branch_origin__` (Current Branch Origin) and `__main_origin__` (Main Development Branch) are stored in the setting as-is and only resolved at refresh time. Main branch candidates are `dev`, `develop`, `main`, `master` — on the preferred remote (HEAD's upstream remote, then `origin`, then the first remote) before local branches.
- **Folders**: VS Code only propagates colors to folders whose children it has rendered, so the provider decorates all ancestor folders of changed files explicitly.
- **Refresh triggers**: `repository.state.onDidChange` (fires after every `git status`), repositories opening/closing and changes to `branchCompare.*`. The diff is against HEAD, so working-tree edits don't need a refresh of their own.
- `repository.state.refs` is deprecated in the Git API and always returns `[]` — use `repository.getBranches` / `getRefs`.

---

## Build & Test

```bash
npm run compile          # type-check + lint + esbuild bundle (out/extension.js)
npm run watch            # parallel: esbuild --watch + tsc --noEmit --watch
npm run compile-tests    # esbuild all test entry points into out/test/
npm test                 # check-types + compile-tests, then node ./out/test/runTests.js
npm run package          # vsce package (.vsix) — runs vscode:prepublish first
```

- **Bundler**: esbuild bundles everything except `vscode` into `out/extension.js` (CJS, Node). Sourcemaps ship in the VSIX. `tsc` is only used for type-checking (`noEmit`).
- **Tests**: `src/test/runTests.ts` first creates a multi-root fixture workspace in the temp folder (`src/test/fixtures/createFixtureRepos.ts`: `repoA` with a local bare origin and a `feature` branch, `repoB` without remote), then starts VS Code with it and runs every `src/test/suite/*.test.ts` through Mocha (`tdd` UI). Integration tests create their own `BranchCompareProvider` and set `branchCompare.baseRefs` in the user settings of the test instance.
- **CI**: `.github/workflows/build.yml` runs on a published release (tests via `.github/actions/vscode-test`, then `vsce package` and upload to the release); `publish.yml` publishes the VSIX to Open VSX (`OPEN_VSX_TOKEN`) and the Visual Studio Marketplace (`VS_MARKETPLACE_TOKEN`).

---

## Cross-Cutting Conventions

- **Constants single source of truth**: command IDs come from `MANIFEST` (package.json); config keys, special refs, timings and limits live in `constants.ts`. Never repeat those literals elsewhere.
- **Per-repository behavior**: never resolve a base ref, fetch or diff through "the active repository" — always use the repository being processed.
- **Failures**: a problem in one repository must not affect the others. Log it once as a warning (`reportFailure`) and skip that repository. `refresh()` never rejects.
- **Disposables**: every listener, emitter and timer is owned by a disposable (`BranchCompareProvider.dispose`) that is registered in `context.subscriptions`.
- **Paths**: compare file system paths only after `normalizeFsPath`, and test containment with `isPathInside` — never with a bare `startsWith`.
- **Settings compatibility**: the format of `branchCompare.baseRefs` (branch name → ref, including the special refs) is user data; keep it backward compatible.
- **ExtensionKind `workspace`**: the extension runs where the repository is (also remote); it needs a trusted workspace like the Git extension.
- **Logging**: Use the static `Logger` class from `src/utils/logger.ts` (`Logger.info/warn/error/debug/trace`) in all extension code. Per-refresh details belong to `debug`/`trace`.

---

## Code Style

### TypeScript

- **Indentation**: 4 spaces
- **Quotes**: single quotes for strings
- **Semicolons**: always
- **Type annotations**: minimal — rely on inference for local variables; explicitly annotate exported function signatures and their parameters
- **Naming**:
  - `camelCase` — variables, functions
  - `PascalCase` — classes, interfaces, types
  - `UPPER_SNAKE_CASE` — module-level constants
  - Interfaces are not `I`-prefixed
- **Null / optionals**: prefer `??` over `||` for defaults; prefer `?.` over explicit null checks
- **`any` vs `unknown`**: never use `any`; use `unknown` at system boundaries (caught errors, external JSON) and narrow before use
- **Error handling**: `try/catch` → `Logger.error(...)` → re-throw or surface via `vscode.window.showErrorMessage`

### Braces and control flow

- Always use braces for `if` / `else` / `for` / `while` — never omit
- Body always on its own line — single-line `if (x) { return; }` is forbidden:
  ```ts
  // ✗
  if (x) { return; }

  // ✓
  if (x) {
      return; // 4-space indent
  }
  ```
- Empty function / constructor bodies: `{ }` with a single space — `deactivate() { }`
- `switch` statement: `case` labels indented 4 spaces inside the `switch` block

### Multiline statements

- **`import` declarations**: always single-line — never split across lines
- **Function / method definitions**: keep the signature on one line
- **Function / method calls**: single-line by default; split to multiline only when multiple arguments make the line hard to read (e.g. a call with an options object). When splitting, put each argument on its own line
- **Object / array literals in arguments**: inline when short; block-indented when the literal has multiple keys or entries

### General

- Comments only where logic is non-obvious — prefer self-documenting code
