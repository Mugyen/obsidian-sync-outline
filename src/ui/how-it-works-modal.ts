import { Modal } from "obsidian";

/** One case: a short header, then what happens. "★" marks something adjustable in Settings. */
const CASES: [string, string][] = [
	[
		"Mapping",
		"Each ★ Outline collection is linked to one vault folder. Each note remembers its Outline document " +
			"through an outlineId line at the top of the note. Folders that aren't linked never leave your vault. " +
			"Top-level folders not yet in Outline are listed under “Vault folders not in Outline”. From there you can " +
			"create a matching collection (visible to the workspace or only you) or link one that has the same name.",
	],
	[
		"How changes are detected",
		"After every sync the plugin saves a fingerprint of each note and of Outline's saved copy. On the next " +
			"check it compares both against those fingerprints to tell your edit from theirs. Timestamps are never " +
			"used to decide.",
	],
	[
		"Timing",
		"Outline is checked every ★ 1 min, and once on startup ★. Your edits are pushed ★ 1 min after you stop " +
			"typing. ⬇ Pull and ⬆ Push in the status bar sync immediately; a click during a running sync runs right " +
			"after it. (A browser edit may not come through yet if Outline hasn't saved it. Refresh the Outline page " +
			"or wait a moment, then Pull again.)",
	],
	[
		"Not real-time",
		"Outline keeps live browser edits in memory and writes them to its database later, sometimes after " +
			"minutes. The plugin can only read what's been written. Good for working in two places; not for live " +
			"co-editing.",
	],
	[
		"Edited in both places",
		"When both fingerprints changed, ★ “When both sides changed” decides. The default is to show you a diff " +
			"with Keep mine / Keep Outline / Keep both / Decide later. Keep both saves Outline's copy next to yours. " +
			"Decide later changes nothing and asks again on the next sync.",
	],
	[
		"Deleting a note",
		"In Outline: ★ moves your copy to Obsidian's trash, or keeps it and drops the link. The plugin first " +
			"confirms with Outline that the document is really deleted. In Obsidian: ★ deletes the Outline document " +
			"too, or (default) leaves Outline alone, and the note downloads again on the next sync.",
	],
	[
		"Deleting a folder or collection",
		"Never deletes anything on the other side. Deleting a linked folder in Obsidian, or its collection in " +
			"Outline, removes the link and stops syncing it. Your files stay where they are. To resume, link them " +
			"again under Folders.",
	],
	[
		"Renames and moves",
		"Renaming a note renames its Outline document, and the other way round. Moving a note to another folder " +
			"moves it in Outline. Renaming a subfolder on either side renames its counterpart. Renaming a linked " +
			"folder keeps the link; the collection keeps its own name.",
	],
	[
		"Folders",
		"Outline has no folders inside a collection, only documents nested in documents. So each subfolder " +
			"becomes a small marked “folder document” that holds the notes inside it. It's created automatically, " +
			"never written as a note in your vault, and any text typed into it in Outline is ignored.",
	],
	[
		"Formatting",
		"Outline stores rich text and rewrites markdown in its own style. ★ “Preserve Obsidian formatting” (on " +
			"by default) converts between the two styles. * bullets become -, Outline's escapes (\\[, \\~) are " +
			"removed, and nested lists are re-indented with tabs the way Obsidian writes them. Single line breaks " +
			"survive through an invisible marker in Outline. Content and nesting never change, only layout. Turned " +
			"off, raw markdown is exchanged, and Outline merges single line breaks.",
	],
	[
		"Other files",
		"★ Listed file types (default html) upload byte-for-byte as an attachment inside a small Outline " +
			"document. They're opened by downloading — Outline doesn't display them inline.",
	],
];

/** "How sync works": every case the plugin handles, in one place. */
export class HowItWorksModal extends Modal {
	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass("outline-sync-info");
		contentEl.createEl("h2", { text: "How Outline Sync handles each case" });
		contentEl.createEl("p", { cls: "outline-sync-subtle", text: "★ = adjustable in Settings" });
		const list = contentEl.createEl("ul", { cls: "outline-sync-cases" });
		for (const [title, body] of CASES) {
			const item = list.createEl("li");
			item.createEl("strong", { text: `${title} — ` });
			item.appendText(body);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
