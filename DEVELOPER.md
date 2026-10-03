# Outline Sync — Developer Notes

The *why* behind the code: decisions, the Outline behaviour they rest on, and the traps already hit. What the code does is in the code; user-facing docs are README, USAGE and the in-app **How sync works** panel (keep that panel in step with §2).

> **Keep this file current.** Every version bump adds a line to §6 (what changed and why) before release. Every significant decision or newly verified Outline quirk is recorded here, with its reason, in the same change.

---

## 1. Ground rules

- **Obsidian is the primary edit surface.** Local formatting must survive; Outline's normalisation must never overwrite a local file. When a design question is ambiguous, this breaks the tie.
- **Never delete what the user didn't ask to delete.** Absence is not deletion; a folder or collection going away stops syncing rather than propagating.
- **Never decide silently.** Conflicts are asked (by default), bulk uploads are confirmed, a click during a sync says so instead of being dropped.
- **Verify Outline behaviour live before relying on it.** Every quirk in §3 was found by probing the real instance; several broke earlier assumptions.

---

## 2. Decisions and why

**Change detection by content hashes, not revisions or timestamps.**
Outline's `revision` lags editor edits (Q6), and a timestamp can't tell *my* edit from *theirs*. So each document keeps a merge base: the hash of the local body and the hash of Outline's *stored* text at last agreement. The remote baseline is re-fetched after every push because Outline re-serialises what we send (Q3); baselining on what we sent would make our own push look like a remote edit and overwrite local formatting ("ghost changes").

**A rename is an edit.** The filename is the title in Obsidian; a rename leaves the body unchanged, so body-only detection let the next pull rename the file back to the stale remote title.

**Who moved a note is decided by whether Outline's parent changed since the base.** Comparing paths alone can't tell a local move from a remote one; without this, a pull reverted local moves.

**Folders are reconciled before notes are scanned.** A folder renamed in Outline would otherwise make every note inside look moved locally, and the move logic created a duplicate folder document under the old name.

**Subfolders are inert "folder placeholder" documents; bare folders only.** Outline nests documents under documents and has no folders inside a collection. The placeholder's text is ignored so nobody's edit to it can create a local note. The user chose bare folders over a `Folder.md` convention (an existing `Folder.md` is still honoured).

**A local rename of a placeholder counts only if Outline's title is unchanged since the base.** Otherwise a rename made in Outline would be pushed back.

**Deleting a linked folder or a collection stops syncing; it never deletes the other side** (user decision). Before this, a deleted collection made every sync fail (Q10), and a deleted folder was downloaded again. Only an explicit 404/403/archived counts as gone, so a network blip can't unlink anything. A mapping whose folder doesn't exist but has never synced is *not* unlinked — that's a collection just switched on.

**Local deletions settle for 1.5 s before acting.** Deleting a folder fires one event per note; deciding immediately would replay a folder delete note by note into Outline (with the delete setting on) before we could see the folder itself is gone.

**Remote deletion is confirmed with `documents.info` before trashing.** A listing once omitted live documents (Q2) and trashed local notes. Trashed documents still answer `documents.info` (Q5), so `deletedAt`/`archivedAt` count as gone.

**Local deletes don't propagate by default.** One person's local delete shouldn't remove a page for the whole team; the note simply downloads again.

**Formatting conversion (on by default, toggleable).** Outline stores rich text, so markdown never round-trips byte-for-byte (Q1, Q3). Single line breaks are the only true information loss; they survive via an invisible U+2060 marker. The user accepted that marker living in Outline's content; the toggle exists for teams that don't. Lists are re-indented the way Obsidian writes them because Outline's layout (Q4) makes Obsidian's editor misread levels and renumber items.

**Non-markdown files sync as attachments inside a small marked document, download-only.** Outline can't render arbitrary HTML inline (Q7) and converting a styled report to a document destroys it. Identity comes from the filename in the marker comment, never the link text (Q9). On a both-sides change, local wins with a warning: there's no meaningful diff for binaries and Obsidian is primary.

**Collections are created only by an explicit button, asking each time workspace vs. only me.** Uploading a folder to a shared wiki must never happen by accident, and the right visibility differs per folder. A same-named unmapped collection is offered for linking instead of creating a duplicate.

**Collections are never renamed by the plugin.** Folder and collection names stay independent; a renamed linked folder keeps its link.

**One sync at a time, with queued requests.** A fresh engine is built per call (so settings changes apply without reload), which meant the engine's own running-flag never guarded anything; overlapping syncs created duplicate documents. A plain lock then silently dropped clicks while a conflict dialog waited, which looked like "already in sync" — hence the queue and the notice.

**Conflicts are asked before the file pass.** The user is waiting on the answer; hashing and transferring attachments is the slow part.

**Timing defaults: check every 10 s, push 10 s after typing stops** (user decision). Changed defaults reach existing installs only through the `settingsVersion` migration, which moves users still on an old default and leaves custom intervals alone.

**Settings lists show two rows, the rest in a "Show more" popup.** Workspaces and vaults grew until the collection and vault-folder lists pushed every other setting off-screen. Synced collections come first because they're the ones you manage; among unsynced vault folders, ones that can link to an existing collection come first. In the popup a flipped toggle re-renders in place rather than re-sorting, so the row doesn't jump away mid-interaction; the popup shows synced-of-total (collections) or the total unsynced (folders) so the hidden count is never a guess.

**`?`, `*`, `:` … in titles become `-` in filenames.** Filesystem limit; the user accepted it as long as no words are lost.

---

## 3. Outline behaviour the code depends on (verified live)

- **Q1** No markdown files: Outline stores a ProseMirror tree and regenerates markdown on every read. There is no raw mode.
- **Q2** `documents.list` with `sort: "index"` returns only root-level documents. Use the default sort.
- **Q3** Round-trip changes: single line breaks inside a block collapse to a space (real loss); `-`→`*`, escapes (`\->`, `\[`, `\~`), table padding and indent widths change (reversible). Headings, ordered/task lists, blank-line paragraphs and fenced code are lossless. Zero-width characters survive verbatim.
- **Q4** Nested lists: markers right-aligned (` 1.` beside `10.`), children at marker width, and a blank line *plus a whitespace-only line* before each sub-list. Valid CommonMark. An ordered sub-list not starting at 1 can't interrupt a paragraph, so one blank line must be kept there.
- **Q5** `documents.info` returns trashed and archived documents.
- **Q6** `revision` is snapshotted periodically by the collaborative editor; `text`/`updatedAt` move first.
- **Q7** Attachments are served with `Content-Disposition: attachment` through signed URLs that expire in ~5 min. Iframe embeds are for external providers only.
- **Q8** Browser edits live in the collaboration server (Hocuspocus/Yjs) and reach the database — and therefore the API — later; ~2 min observed once despite 2–10 s defaults. Sync can never be faster than this.
- **Q9** Link text is padded on save: `[x](…)` becomes `[ x](…)`. HTML comments are kept verbatim.
- **Q10** Deleted collection: `collections.info` → 404, `documents.list` → 403.
- **Q11** `collections.create` `permission: "read_write"` = workspace, `null` = private. `documents.import` exists but is lossy for styled HTML.

When a new quirk is found, reproduce it in `test/` fakes (as `FakeClient.storeText` does for Q3/Q9) so the regression test actually fails without the fix — several bugs passed tests because the fake was more polite than Outline.

---

## 4. Release and testing gotchas

- Release tag must equal the manifest version, no `v` prefix, with `main.js`, `manifest.json`, `styles.css` attached — otherwise BRAT ignores it.
- Never re-upload a released version: BRAT only fetches a version number it hasn't seen. Ship a patch.
- Copying `main.js` into a vault doesn't reload a running plugin; toggle it off/on before testing.
- Behaviour changes go to a scratch vault for the user to try before release.
- `main.js` is committed so the repo is install-ready.
- On the maintainer's Mac `gh` is a shell alias; call `/opt/homebrew/bin/gh`.
- The repo is public: no server hostnames, tokens or collection ids in it (an internal handoff doc was removed for this reason).

---

## 5. Known limits and ideas not taken (yet)

- **Not real-time** (Q8). Idea: join Outline's collaboration socket as a Yjs client and serialise the live document to Obsidian markdown ourselves — instant, and it would remove most conversion workarounds. Not built: unclear whether an API key can authenticate that socket, and it depends on undocumented internals. Cheaper option: shorten the server's persistence delay.
- **Headless daemon / OS mount.** Discussed, not built. A synced real folder beats a virtual mount for a small-text wiki (offline, no kernel extension). Would need `SyncEngine`'s Obsidian dependencies behind vault/HTTP interfaces, living in a subfolder with its own versioning so BRAT is unaffected. Plugin and daemon must never own the same folder.
- **Official community store.** Hard requirements met; mobile (`isDesktopOnly: false`) is untested, so verify that first.
- Outline writes an empty paragraph inside a list as a lone `\`, shown literally in Obsidian.
- Notes pulled before 0.6.4 keep the old list layout until pulled again.
- A folder whose notes still carry `outlineId`s from a *different* collection won't upload via "Create collection"; link the original collection instead.

---

## 6. History that explains the design

- **0.1** Revision-based merge base, conflict dialog, `Folder.md` nesting.
- **0.2** Pull/Push buttons → directional sync.
- **0.3** Placeholders replace `Folder.md`; `sort:"index"` (Q2) trashed nested notes → confirm-before-trash.
- **0.3.1–0.4** Revision lag (Q6) and ghost changes → content hashes + stored-form baseline; soft-break marker; renames stopped reverting.
- **0.5** Folder moves via `documents.move`.
- **0.6.x** Attachment files; link padding (Q9) caused duplicates → name in marker; sync lock; trashed docs (Q5) blocked deletions; Obsidian-native lists (Q4); queued clicks.
- **0.7.0** Folders → collections; delete/rename of folders and collections never cross-deletes; Outline-side folder rename no longer duplicates; How sync works panel.
- **0.7.1** 10 s defaults.
- **0.7.2** Long settings lists capped at two rows + "Show more" popup with counts.
