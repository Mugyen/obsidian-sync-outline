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
3. **Map collections.** Each collection has an **Enable** toggle. Turn it on, then open the caret for **Local folder** (where the notes live) and **Local files always sync** (whether new notes in that folder sync by default).

Because each person authenticates as themselves, every vault mirrors exactly what that person can already see in Outline.

## Leaving a note out of sync

A mapped folder syncs every note in it unless that note opts out. The opt-out is a checkbox property, `outlineSuppressed`, in the note's frontmatter.

- **Unchecked** (`false`): the note syncs.
- **Checked** (`true`): the note is left alone. It is not pushed, not pulled over, and not created in Outline. Deleting the note locally does not delete the Outline document, even if **Delete Outline document when the note is deleted** is on. If someone else deletes that document in Outline, the local note is not trashed or overwritten. Unchecking the box lets the next sync see that the document is gone.

You do not have to add the property yourself.

- A new note in a mapped folder gets the checkbox immediately. Whether it starts checked depends on **Local files always sync** for that folder. On means new notes sync unless you check the box. Off means new notes stay local until you uncheck it.
- A note created by a pull (it already exists in Outline) gets the box unchecked.
- The first time this version runs, notes already in a mapped folder that lack the property get an unchecked box, so nothing that was already syncing suddenly stops. The folder default applies only to notes created after that.

Toggle it from the note's properties, or with the command **Toggle suppression for the active note**. Checking the box on a note that has already synced also writes `outlineLastsync`, the time local and Outline last agreed, so you can see when it dropped out. Unchecking the box does not remove the property. The note rejoins sync on the next run.

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

Documents are identified by an `outlineId` in frontmatter, so renaming or moving a note in Obsidian doesn't break the link. A rename retitles the document in Outline. `outlineSuppressed` is the per-note opt-out described above. `outlineLastsync` is set only when a previously synced note is suppressed.

## Settings worth knowing

| Setting | What it does |
| --- | --- |
| **Check Outline every** | Poll interval for other people's edits. Your own local edits don't wait for this — they push a few seconds after you stop typing. |
| **Local files always sync** | Per mapped folder, under the caret. On: new notes sync unless you check `outlineSuppressed`. Off: new notes start suppressed. |
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
