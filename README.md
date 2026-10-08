# <img src="./assets/icon.png" alt="" height="32"> Branch Compare Decorations

Choose which branch the Git file decorations in the Explorer compare against. Branch Compare Decorations marks every file your branch changed compared to a base branch — `origin/main`, the point where your branch was created, or any other ref — with the familiar Git badges and colors, next to the built-in decorations for uncommitted changes.

---

## ✨ Features

- **A base ref per branch** — every local branch remembers what it is compared against; switching branches switches the comparison
- **Special comparisons** — *Current Branch Origin* shows all changes since the branch was created, *Main Development Branch* all changes since branching from `dev`, `develop`, `main` or `master`
- **Git look and feel** — `A`, `M`, `D` and `R` badges in the Git decoration colors of your theme; folders containing changes are highlighted even while collapsed
- **Multi-repository workspaces** — every repository is compared against the base ref of its own current branch
- **Auto fetch** — remote base refs are fetched before comparing (at most every 30 seconds)
- **Fork-point aware** — uses `git merge-base --fork-point`, so a rebased base branch doesn't flood the Explorer with unrelated changes
- **On/off switch** — deactivate the decorations to get VS Code's plain Git decorations back, and activate them again whenever you need them

---

## 🧰 Usage

Run **Branch Compare Decorations: Set Base Branch** from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`). In a workspace with several repositories, pick the repository first. Then choose what its current branch is compared against:

| Option                      | Compares against                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Current Branch Origin**   | The point where the current branch was created from a main development branch                                 |
| **Main Development Branch** | The fork point from the first existing branch of `dev`, `develop`, `main`, `master` (remote first, then local) |
| A remote branch             | The selected branch of any remote                                                                               |
| **Enter manually…**         | Any branch, tag or commit                                                                                       |
| **Disable**                 | Nothing — no decorations for this branch                                                                        |

Hover a decorated file to see what it is compared against.

**Branch Compare Decorations: Refresh Decorations** recomputes everything from scratch, e.g. after a base branch was force-pushed.

**Branch Compare Decorations: Deactivate** removes all decorations of this extension, so the Explorer shows only VS Code's built-in Git decorations again. It stays off in every window until you run **Branch Compare Decorations: Activate**.

---

## ⚙️ Extension Settings

| Setting                              | Default | Description                                                                                                                                                                          |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `branchCompareDecorations.enabled`   | `true`  | Show this extension's decorations. When off, only VS Code's built-in Git decorations remain. Switched by **Deactivate** and **Activate**.                                            |
| `branchCompareDecorations.baseRefs`  | `{}`    | Base ref per local branch name, e.g. `{ "feature/login": "origin/main" }`. `__branch_origin__` and `__main_origin__` select the special comparisons. Written by **Set Base Branch**. |
| `branchCompareDecorations.autoFetch` | `true`  | Fetch the remote base ref (at most every 30 seconds) before computing changes.                                                                                                       |

> **Note:** `branchCompareDecorations.baseRefs` is stored in your user settings and keyed by branch name only, so e.g. all branches named `main` share one base ref across repositories.

---

## 🧠 Requirements

- Git, with VS Code's built-in Git extension enabled (`git.enabled`) in a trusted workspace
- VS Code 1.105 or later

Branch Compare Decorations runs where your workspace is, so it also works over Remote SSH, WSL and Dev Containers.

---

## 🧩 Repository

GitHub: [Florian-Noever/branch-compare-decorations](https://github.com/Florian-Noever/branch-compare-decorations)

Bug reports and feature requests are welcome via [Issues](https://github.com/Florian-Noever/branch-compare-decorations/issues).

---

## 🛠️ Developer Notes

### Project Architecture

| Path                                 | Purpose                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `src/extension.ts`                   | Activation: gets the Git API, registers the decoration provider and the commands          |
| `src/utils/branchCompareProvider.ts` | `FileDecorationProvider`: computes the changed files per repository, fires change events |
| `src/utils/baselineResolver.ts`      | Resolves the special base refs and the fork point HEAD is compared against               |
| `src/utils/gitBranchPicker.ts`       | Quick picks for the repository and the base ref                                           |
| `src/handlers/`                      | Command handlers                                                                          |
| `src/test/`                          | Mocha unit and integration tests, run inside a VS Code extension host                     |

### Build Commands

```bash
# Type-check, lint and bundle the extension with esbuild
npm run compile

# Bundle and type-check in watch mode (default build task)
npm run watch

# Run the unit and integration tests (downloads VS Code on first run)
npm test

# Package the extension as a .vsix
npm run package
```

The integration tests create throwaway Git repositories in the temp folder and open them in a separate VS Code instance.

### CI & Releases

CI runs on every push and pull request through the shared workflows of [Florian-Noever/Florian-Noever](https://github.com/Florian-Noever/Florian-Noever/blob/main/.github/CI.md). It runs the unit and integration tests in VS Code and packs a preview VSIX.

To release, bump the version with `npm version x.y.z --no-git-tag-version` and publish a GitHub release `vx.y.z` from a commit whose CI is green. The publish workflow builds and tests the tag, attaches the VSIX to the release and publishes it to the Visual Studio Marketplace and Open VSX.

---

## 📜 License

Licensed under the [MIT License](./LICENSE).

<br>
<br>

[!["Buy me a coffee"](https://raw.githubusercontent.com/Florian-Noever/Florian-Noever/refs/heads/main/_meta/BuyMeACoffee/Buttons%20%26%20Icons/orange-button-x180.png)](https://www.buymeacoffee.com/florian_noever)
