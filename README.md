# Sidebar Entries · dsh-visibility

[![test](https://github.com/zqdomo/dsh-visibility/actions/workflows/test.yml/badge.svg)](https://github.com/zqdomo/dsh-visibility/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**English** · [简体中文](README.zh-CN.md)

![Sidebar Entries settings panel](docs/screenshot-settings.png)

A sidebar entry manager for DSH: turn any settings section into a one-click sidebar entry, and reorder, hide, or collapse **every row of the sidebar — including the built-in "Plugins" and "Tasks" rows**.

Client-side only. No backend, no database, no fighting React's render order. All state lives in `localStorage`, so deleting the folder restores everything cleanly.

## What it does

| Capability | Detail |
| --- | --- |
| **Section shortcuts** | Pick any settings section (Skills, Models, Plugins…) and pin it to the sidebar. One click opens Settings and jumps straight to that section |
| **Drag to reorder** | Every row is draggable, including built-in rows like "Plugins" and "Tasks" |
| **Hide a row** | Any row can be hidden. Its **position is remembered** — show it again and it returns to where it was, not to the bottom |
| **Collapse the group** | One "Collapse / Expand" toggle folds the whole group into a single header line, giving the space back to your session list |
| **Restore all** | A "Show all" button at the bottom of the panel undoes accidental hiding |
| **Migration** | Automatically detects and migrates the v1 / v2 / v3 storage formats |

## Usage

<img src="docs/screenshot-sidebar.png" alt="Sidebar result" width="285">

1. Open Settings: click your avatar in the bottom-left corner, or press `Ctrl + ,`
2. Find **"Sidebar Entries"** at the bottom of the left nav
3. The panel has two parts:
   - **Top:** rows currently on the sidebar, in their actual order. Drag to reorder. Built-in rows offer "Hide" — the position is remembered, so it returns to the same spot later. Sections you pinned offer "Remove", which sends them back to the list below
   - **Bottom:** settings sections that are not on the sidebar yet. Click "Add" to pin one
4. You can also drag directly on the sidebar: drop on the upper half of a row to insert before it, lower half to insert after
5. The header row at the top of the group collapses everything

> State is stored in `localStorage` under the key `dsh-sidebar-links.v4`. It does not sync across browser profiles or machines — that is intended.

## Installation

The package name is `@local/dsh-visibility`. The `@local` prefix exists so that a local `link:` install keeps working; it does not affect installing from GitHub.

### Option 1: Install from GitHub (for everyone else)

Edit your DSH profile config at `~/.dsh/profiles/<profile>/package.json` and add one line to `dependencies`:

```json
"@local/dsh-visibility": "git+https://github.com/zqdomo/dsh-visibility.git"
```

Then add the package name to `dsh.profile.bundles` in the same file:

```json
"dsh": {
  "profile": {
    "bundles": [
      "...",
      "@local/dsh-visibility"
    ]
  }
}
```

Run `npm install` (or `pnpm install`) inside `~/.dsh/profiles/<profile>/`, then restart DSH.

### Option 2: Local development

Clone the repo anywhere and point `link:` at it:

```json
"@local/dsh-visibility": "link:/path/to/dsh-visibility"
```

Add it to `dsh.profile.bundles` as well, then restart DSH.

### Uninstall

Remove those two entries and restart. Leftover `localStorage` keys can be cleared by hand; leaving them does no harm.

## How it works

The Settings modal's open state is held by a private store inside the `settings-general` package, with no public service. The `settings.open` command on desktop is dispatched through native keyboard handling only, so a synthetic `KeyboardEvent` does nothing. This plugin therefore does not try to "call" Settings open — it walks the **real UI path**:

```
account menu button (button[aria-haspopup="menu"])
  → menu item "Settings" (button[role="menuitem"])
    → section navCell inside [data-shortcut-modal="settings"]
```

All three are real DOM nodes, so the result is exactly what a user clicking through would see.

**Reordering** never touches DOM order. The sidebar list is `display:flex; flex-direction:column`, so the plugin writes a CSS `order` value on each row. Visual order becomes arbitrary while React remains unaware of it — which means React can never put the order back.

**Hiding** sets an inline `display:none`. React only trusts its own props and will not clear `style.display`.

**Hot-reload safety:** every module load bumps a generation counter (`window.__dshVisibilityGen`). Instances that are not the newest shut themselves down, so a hot-replaced `client.js` cannot leave two copies fighting over clicks.

## Known limitations

- Depends on the current DSH DOM structure (aria-labels, `data-shortcut-modal`, …). A major DSH redesign may break it; the fix is to update the selector constants at the top of `client.js`.
- Client-side only (Web / desktop WebView). The host side is an empty `apply()` that registers no capabilities.
- Configuration is per-browser: no sync, no sharing.
- In a very narrow sidebar (rail mode), entries are squeezed into square icons because they follow the built-in row width.

## Development

```
dsh-visibility/
├── index.js              # host half: empty apply(), only so the Loader claims the package
├── client.js             # client half: all the logic (~1500 lines, heavily commented)
├── cordis.patch.yml      # Loader patch that inserts this package into the plugin tree
├── package.json
├── docs/                 # screenshots
└── tests/
    ├── order.test.cjs         # pure functions for the order table (migration, completion, move index)
    └── apply-order.test.cjs   # applyOrder against a fake DOM
```

Run the tests (plain Node, no dependencies to install):

```bash
npm test
# same as
node tests/order.test.cjs && node tests/apply-order.test.cjs
```

The tests extract the code under test **verbatim out of `client.js`** by marker comment or function signature, then run it. Implementation edits therefore never break the tests through shifting line numbers — the tradeoff is that those marker comments (`const SYS = 'sys:'`, `持久化`, the function signatures) must not be deleted casually.

When changing client code, keep DSH's hot-reload behaviour in mind: replacing `client.js` does not dispose the old instance, so any new global listener needs a generation guard.

## License

[MIT](./LICENSE) © 2026 zqdomo
