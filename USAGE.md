# Outline Sync — Usage

Everything operational: install, setup, settings, on-disk layout, and building from source. For what the plugin *is* and why, see the [README](README.md).

## Install

### Via BRAT (recommended — auto-updates)

1. In Obsidian: **Settings → Community plugins → Browse**, install **BRAT** ("Obsidian42 - BRAT"), enable it.
2. Command palette (`Cmd/Ctrl+P`) → **BRAT: Add a beta plugin for testing**.
3. Enter the repo: `Mugyen/obsidian-sync-outline` → **Add Plugin**.
4. BRAT installs **Outline Sync** and enables it. New releases update automatically.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Mugyen/obsidian-sync-outline/releases/latest) and drop them into:

```
<vault>/.obsidian/plugins/outline-sync/
```

Then enable **Outline Sync** under Settings → Community plugins (Restricted Mode off). Those three files are the entire install — for a fleet, ship them with MDM or a small script.

## Setup

1. **Get a token.** In Outline: **Settings → API → New API key**. It acts as you and inherits your collection permissions, so everyone uses their own. Never paste one into a repo or chat.
2. **Connect.** Obsidian → **Settings → Outline Sync** → paste your instance URL (e.g. `https://outline.example.com`, no `/api` suffix) and token → **Connect**. It reports your name and lists collections.
3. **Map collections.** Toggle on each collection you want and name the vault folder it mirrors into.

Because each person authenticates as themselves, every vault mirrors exactly what that person can already see in Outline.

## On disk

Each mapped collection becomes a folder. Nesting uses Obsidian's folder-note convention (`Parent.md` beside `Parent/`):

```
Vault/
  Engineering/                  ← one mapped collection
    Handbook.md                 ← a document
    Handbook/                   ← its child documents
      Oncall.md
  Outline Attachments/
    1b9a2c3d-….png              ← images pulled from Outline
```

Documents are identified by an `outlineId` in frontmatter, so renaming or moving a note in Obsidian doesn't break the link — a rename retitles the document in Outline.

## Settings worth knowing

| Setting | What it does |
| --- | --- |
| **Check Outline every** | How often to pull other people's edits (default 10 s). Outline saves browser edits to its database with a delay, so changes made there can take longer to appear. |
| **Push local edits after** | Quiet period after your last keystroke before a note is pushed (default 10 s), or *Manual only*. The status-bar ⬇ Pull / ⬆ Push buttons sync immediately. |
| **When both sides changed** | Conflict policy. Leave on **Ask me** unless you have a reason. |
| **Delete Outline document when the note is deleted** | Off by default. With it off, deleting a note locally just re-downloads it next sync (safe). On, it removes the doc for the whole team. |

## Conflicts

When both sides changed the same document since the last agreement, you get a modal with a diff of your note against Outline's version and four choices:

- **Keep local** — your version is pushed.
- **Keep Outline** — Outline's version is pulled in.
- **Keep both** — yours is pushed; Outline's is saved beside it as `Note (Outline 2026-09-07 14-32).md`.
- **Decide later** — nothing changes on either side; the same question returns next sync.

## Known limits

- **Markdown is lossy toward Outline.** Outline stores rich text; a push that rewrites a doc drops inline comments, highlights, and table column widths. Pulls are unaffected.
- **Wikilinks don't translate.** `[[wikilinks]]` render as literal text in Outline — turn them off (Settings → Files and links) if links must survive. Image embeds (`![[image.png]]`) *are* converted to Outline attachments on push.
- **Drafts aren't synced.** Unpublished Outline documents are skipped.
- **No real-time.** Polling, not websockets.

## Building from source

```bash
git clone https://github.com/Mugyen/obsidian-sync-outline.git
cd obsidian-sync-outline
npm install
npm run build          # produces main.js
```

Requires Node 20+ (built on Node 24 / npm 11). Copy `main.js`, `manifest.json`, `styles.css` into your vault's plugin folder as above.

## Development & tests

```bash
npm run dev     # rebuild on change
npm test        # pure + engine tests, no network
OUTLINE_URL=https://outline.example.com OUTLINE_API_TOKEN=… npm run test:live
```

`npm test` runs against an in-memory vault and a fake Outline, covering the reconcile matrix, conflict resolution, nesting, renames, and deletions. `test:live` is **read-only** — it only checks that a real install answers the way the client expects, and never writes to the wiki.

## Releasing

1. Bump `version` in `manifest.json` (and add the mapping to `versions.json`).
2. `npm run build` to regenerate `main.js`.
3. Commit, then cut a GitHub release whose **tag exactly matches** the manifest version, with **no `v` prefix** (e.g. `0.2.0`):

   ```bash
   gh release create 0.2.0 main.js manifest.json styles.css --title 0.2.0
   ```

BRAT picks up the new release and updates everyone automatically.
