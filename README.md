# Outline Sync

**Your Obsidian vault and your [Outline](https://www.getoutline.com/) wiki, kept as one body of content.** Edit a note on your Mac, it shows up in the wiki. Someone edits the wiki, it shows up in your vault. Both edited the same doc? It stops and *asks you* — it never silently picks a winner.

```
You edit  Handbook.md  locally ─┐
                                ├─► reconcile ─► push / pull / ASK
Teammate edits it in Outline  ──┘
```

## ✨ What this is

- 🔁 **Genuinely two-way.** Not an export. Changes flow both directions, continuously.
- 🧠 **Merge-base aware.** Uses Outline's `revision` counter to tell *"I changed this"* from *"they changed this."*
- 🛑 **Conflict-safe.** When both sides changed, you get a diff and four choices — keep mine, keep theirs, keep both, or decide later.
- 🗂️ **Nesting preserved.** Collections become folders; child documents become `Parent/Child.md`.
- 🖼️ **Attachments handled.** Images pull down and re-upload on push, identity intact.
- 🔑 **Per-person tokens.** Each user syncs exactly what they can already see in Outline.
- 🚫 **Per-note opt-out.** A mapped folder can still skip a note. Check `outlineSuppressed` and that note is left alone: not pushed, not pulled over, and not deleted on either side because the other side deleted it.
- 📦 **Three-file install.** No runtime dependencies, desktop or mobile.

## 🚫 What this isn't

- 🚫 **Not real-time.** It polls; it isn't a participant in Outline's live collaborative editor.
- 🚫 **Not lossless toward Outline.** Markdown can't express inline comments, highlights, or table column widths — a push that rewrites a doc drops them. Pulls are unaffected.
- 🚫 **Not a wikilink translator.** `[[wikilinks]]` render as literal text in Outline. Turn them off if links must survive.
- 🚫 **Not a draft syncer.** Unpublished Outline documents are skipped.
- 🚫 **Not a backup tool.** It syncs current state; it isn't versioned history (Outline already keeps that).

## 💪 Why this exists

We wanted our team's Obsidian vaults and our self-hosted Outline wiki to be the *same content* — Google-Drive-style, edit anywhere — but with an honest answer when two people touch the same doc. Nothing off the shelf did that:

| Tool | Why it didn't fit |
| --- | --- |
| `kingston/outline-sync` | Manual `download` / `upload` commands. "Bidirectional" means both directions exist, not that anything reconciles. No conflict detection. |
| `gmiles32/obsout` | Flat-only (no nesting), and "newer mtime wins, older file overwritten" — silent data loss. |
| Outline's own export | One-way. Not sync. |

We wanted continuous, nested, conflict-aware sync. So we built it.

## 👥 Who this is for

✅ **Use this if you:**
- 🏢 Run a self-hosted Outline instance your team writes in
- 📝 Prefer drafting in Obsidian but want it to land in the wiki
- 👥 Have more than one person editing the same docs
- 🔐 Want each person syncing under their own permissions

❌ **Don't use this if you:**
- ☁️ Use Outline's hosted cloud and never touch Obsidian
- 🎨 Depend on Outline rich-text features markdown can't represent
- ⚡ Need instant, keystroke-level collaboration (that's Outline's editor, in the browser)

## 🧠 How it works under the hood

Every Outline document has a monotonic `revision` counter. The plugin stores, per document, the revision **and** a body hash from the last moment local and remote agreed — the **merge base**. Each sync compares three states:

| Local vs base | Outline vs base | Action |
| --- | --- | --- |
| unchanged | unchanged | nothing |
| **changed** | unchanged | push to Outline |
| unchanged | **changed** | pull into the vault |
| **changed** | **changed** | 🛑 **conflict — ask** |

Nothing is overwritten on the strength of a timestamp unless you explicitly choose the "keep whichever was edited last" policy. Sync state lives in the plugin's own `data.json`, never in your notes — so the plugin doesn't chase its own writes.

A note can opt out without leaving the folder. `outlineSuppressed: true` in its frontmatter takes it out of that table entirely: no push, no pull, no "the other side deleted it, so delete mine." New notes in a mapped folder get the checkbox automatically; whether it starts checked is a per-folder setting. Details are in **[USAGE.md](USAGE.md)**.

> **The one race that can't be closed:** Outline's `documents.update` has no compare-and-swap, so a push is check-then-write. If someone writes *inside* that window it's detected afterward (the revision jumps by more than one) and reported — the overwritten text stays recoverable in Outline's history. Practically: don't sit in the Outline browser editor on a doc you're also editing locally.

## 🚀 Install

**Easiest — via [BRAT](https://github.com/TfTHacker/obsidian42-brat) (auto-updates):**

1. Install & enable **BRAT** from Community plugins.
2. Command palette → **BRAT: Add a beta plugin** → `Mugyen/obsidian-sync-outline`.
3. Open **Settings → Outline Sync**, paste your Outline URL + personal API token, hit **Connect**, and map a collection to a folder.

**Manual:** grab `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/Mugyen/obsidian-sync-outline/releases/latest) into `<vault>/.obsidian/plugins/outline-sync/`.

Full setup, settings reference, and development notes live in **[USAGE.md](USAGE.md)**.

## 📖 More

- **[USAGE.md](USAGE.md)** — install, setup, every setting, building from source, tests
- **[LICENSE](LICENSE)** — MIT

## 🚧 Status

Works, tested, and in use internally. 49 automated tests pass offline; verified read-only against a live Outline instance. Filed under "early but honest" — issues and PRs welcome at [Mugyen/obsidian-sync-outline](https://github.com/Mugyen/obsidian-sync-outline).
