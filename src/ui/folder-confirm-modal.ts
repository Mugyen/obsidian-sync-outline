import { Modal, Setting, type App } from "obsidian";

/** What the user chose for a vault folder: create (with a visibility), map, or nothing. */
export type FolderChoice = "workspace" | "private" | "map" | "cancel";

/**
 * Confirms turning a vault folder into an Outline collection. Creating one asks
 * who should see it; mapping onto an existing collection just confirms. Either
 * way the next sync uploads the folder to the shared wiki, so it is never silent.
 */
export class FolderConfirmModal extends Modal {
	private choice: FolderChoice = "cancel";
	private resolve!: (choice: FolderChoice) => void;

	constructor(
		app: App,
		private readonly options: {
			folder: string;
			notes: number;
			files: number;
			/** Name of a same-named collection to map onto; absent means create one. */
			existing?: string;
			/** False when "create documents for new notes" is off, so nothing would upload. */
			uploadsNewNotes: boolean;
		},
	) {
		super(app);
	}

	openAndWait(): Promise<FolderChoice> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		const { folder, notes, files, existing, uploadsNewNotes } = this.options;
		const contents = [`${notes} note${notes === 1 ? "" : "s"}`];
		if (files > 0) contents.push(`${files} file${files === 1 ? "" : "s"}`);

		contentEl.createEl("h3", { text: existing ? `Sync "${folder}" with "${existing}"` : `Create "${folder}" in Outline` });
		contentEl.createEl("p", {
			text: existing
				? `The folder "${folder}" will be synced with the existing Outline collection "${existing}". ` +
					`Its documents download into the folder, and your ${contents.join(" and ")} upload to it.`
				: `A new collection "${folder}" will be created, and the ${contents.join(" and ")} in this folder ` +
					"will upload to it on the next sync. Subfolders become nested documents.",
		});
		if (!uploadsNewNotes) {
			contentEl.createEl("p", {
				cls: "mod-warning",
				text: '"Create documents for new notes" is off, so your local notes won\'t upload until you turn it on.',
			});
		}

		const buttons = new Setting(contentEl);
		if (existing) {
			buttons.addButton((button) => button.setButtonText("Sync with it").setCta().onClick(() => this.finish("map")));
		} else {
			buttons
				.setDesc("Who should see it?")
				.addButton((button) =>
					button.setButtonText("Everyone in the workspace").onClick(() => this.finish("workspace")),
				)
				.addButton((button) => button.setButtonText("Only me").onClick(() => this.finish("private")));
		}
		buttons.addButton((button) => button.setButtonText("Cancel").onClick(() => this.finish("cancel")));
	}

	private finish(choice: FolderChoice): void {
		this.choice = choice;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.choice);
	}
}
