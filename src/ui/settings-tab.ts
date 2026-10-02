import { Notice, PluginSettingTab, Setting, TFolder, type App } from "obsidian";

import { OutlineClient } from "../outline/client";
import type OutlineSyncPlugin from "../main";
import { isInsideFolder, planLocalFolders } from "../sync/paths";
import type { ConflictPolicy, OutlineCollection } from "../types";
import { FolderConfirmModal } from "./folder-confirm-modal";
import { HowItWorksModal } from "./how-it-works-modal";

export class OutlineSyncSettingTab extends PluginSettingTab {
	private collections: OutlineCollection[] = [];

	constructor(
		app: App,
		private readonly plugin: OutlineSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const about = new Setting(containerEl)
			.setName("Outline Sync")
			.setDesc(`Version ${this.plugin.manifest.version} · Syncs one Outline collection with one vault folder. `)
			.addButton((button) =>
				button.setButtonText("How sync works").setCta().onClick(() => new HowItWorksModal(this.app).open()),
			);
		about.descEl.createEl("a", {
			text: "Latest release",
			href: "https://github.com/Mugyen/obsidian-sync-outline/releases/latest",
		});

		new Setting(containerEl).setName("Connection").setHeading();

		new Setting(containerEl)
			.setName("Outline URL")
			.setDesc("The base URL of your Outline install, without /api.")
			.addText((text) =>
				text
					.setPlaceholder("https://outline.example.com")
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value.trim().replace(/\/+$/, "");
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API token")
			.setDesc(
				"Create one in Outline under Settings → API. It acts as you, so give it only the access you want synced.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("ol_api_…")
					.setValue(this.plugin.settings.apiToken)
					.onChange(async (value) => {
						this.plugin.settings.apiToken = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Checks the token and loads your collections.")
			.addButton((button) =>
				button
					.setButtonText("Connect")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true).setButtonText("Connecting…");
						try {
							const client = new OutlineClient(
								this.plugin.settings.baseUrl,
								this.plugin.settings.apiToken,
							);
							const me = await client.whoami();
							this.collections = await client.listCollections();
							new Notice(`Connected as ${me.name} · ${this.collections.length} collection(s)`);
							this.display();
						} catch (error) {
							new Notice(String(error), 8000);
							button.setDisabled(false).setButtonText("Connect");
						}
					}),
			);

		new Setting(containerEl).setName("Folders").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Each collection you enable is mirrored into one folder of this vault.",
		});

		if (this.collections.length === 0) {
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "Connect above to list your collections.",
			});
			for (const mapping of this.plugin.settings.mappings) {
				new Setting(containerEl)
					.setName(mapping.collectionName || mapping.collectionId)
					.setDesc(`Folder: ${mapping.folder}`)
					.addButton((button) =>
						button
							.setButtonText("Remove")
							.setWarning()
							.onClick(async () => {
								this.plugin.settings.mappings = this.plugin.settings.mappings.filter(
									(candidate) => candidate.collectionId !== mapping.collectionId,
								);
								await this.plugin.saveSettings();
								this.display();
							}),
					);
			}
		}

		for (const collection of this.collections) {
			const mapping = this.plugin.settings.mappings.find(
				(candidate) => candidate.collectionId === collection.id,
			);

			const setting = new Setting(containerEl).setName(collection.name);
			setting.addText((text) =>
				text
					.setPlaceholder("Vault folder")
					.setValue(mapping?.folder ?? collection.name)
					.setDisabled(!mapping)
					.onChange(async (value) => {
						const current = this.plugin.settings.mappings.find(
							(candidate) => candidate.collectionId === collection.id,
						);
						if (!current) return;
						current.folder = value.trim().replace(/^\/+|\/+$/g, "");
						await this.plugin.saveSettings();
					}),
			);
			setting.addToggle((toggle) =>
				toggle.setValue(Boolean(mapping)).onChange(async (enabled) => {
					if (enabled) {
						this.plugin.settings.mappings.push({
							collectionId: collection.id,
							collectionName: collection.name,
							folder: collection.name,
						});
					} else {
						this.plugin.settings.mappings = this.plugin.settings.mappings.filter(
							(candidate) => candidate.collectionId !== collection.id,
						);
					}
					await this.plugin.saveSettings();
					this.display();
				}),
			);
		}

		if (this.collections.length > 0) this.displayLocalFolders(containerEl);

		new Setting(containerEl).setName("Syncing").setHeading();

		new Setting(containerEl)
			.setName("Check Outline every")
			.setDesc("How often to look for changes made by other people. Set to 0 to only sync manually.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"0": "Never (manual only)",
						"30": "30 seconds",
						"60": "1 minute",
						"300": "5 minutes",
						"600": "10 minutes",
						"900": "15 minutes",
						"1800": "30 minutes",
					})
					.setValue(String(this.plugin.settings.pollIntervalSeconds))
					.onChange(async (value) => {
						this.plugin.settings.pollIntervalSeconds = Number(value);
						await this.plugin.saveSettings();
						this.plugin.restartPolling();
					}),
			);

		new Setting(containerEl)
			.setName("Push local edits after")
			.setDesc("Quiet period following your last keystroke before a note is sent to Outline. Manual only pushes nothing automatically — use the status-bar ⬆ button or the command.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"0": "Manual only",
						"1000": "1 second",
						"3000": "3 seconds",
						"10000": "10 seconds",
						"30000": "30 seconds",
						"60000": "1 minute",
						"300000": "5 minutes",
						"600000": "10 minutes",
						"900000": "15 minutes",
						"1800000": "30 minutes",
					})
					.setValue(String(this.plugin.settings.pushDebounceMs))
					.onChange(async (value) => {
						this.plugin.settings.pushDebounceMs = Number(value);
						await this.plugin.saveSettings();
						this.plugin.rebuildPushDebounce();
					}),
			);

		new Setting(containerEl)
			.setName("Sync on startup")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("When both sides changed")
			.setDesc("Asking is the only option that never discards someone's writing without you seeing it.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						ask: "Ask me",
						newer: "Keep whichever was edited last",
						local: "Always keep my local note",
						remote: "Always keep Outline's version",
					})
					.setValue(this.plugin.settings.conflictPolicy)
					.onChange(async (value) => {
						this.plugin.settings.conflictPolicy = value as ConflictPolicy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Files").setHeading();

		new Setting(containerEl)
			.setName("Attachment folder")
			.setDesc("Where images downloaded from Outline are stored.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.attachmentFolder)
					.onChange(async (value) => {
						this.plugin.settings.attachmentFolder = value.trim().replace(/^\/+|\/+$/g, "");
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Create Outline documents for new notes")
			.setDesc("New notes inside a synced folder become documents in the matching collection.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.createRemoteForNewFiles).onChange(async (value) => {
					this.plugin.settings.createRemoteForNewFiles = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Delete local note when deleted in Outline")
			.setDesc("Off keeps the note and warns instead.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.propagateRemoteDeletes).onChange(async (value) => {
					this.plugin.settings.propagateRemoteDeletes = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Delete Outline document when the note is deleted")
			.setDesc(
				"Off by default. Deleting a note locally otherwise removes it for everyone; it will simply be downloaded again.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.propagateLocalDeletes).onChange(async (value) => {
					this.plugin.settings.propagateLocalDeletes = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Preserve Obsidian formatting")
			.setDesc(
				"Convert markdown between Obsidian and Outline so your local formatting survives the round-trip — line breaks, dash bullets, no stray escapes. Adds an invisible marker to Outline documents to keep soft line breaks. Turn off to exchange raw markdown and keep Outline documents marker-free (soft breaks will merge).",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.convertMarkdown).onChange(async (value) => {
					this.plugin.settings.convertMarkdown = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Sync these file types too")
			.setDesc(
				"Comma-separated extensions of non-markdown files to sync (e.g. html, pdf, csv). Each syncs as a downloadable attachment in Outline. Leave blank to sync only Markdown.",
			)
			.addText((text) =>
				text
					.setPlaceholder("html, pdf")
					.setValue(this.plugin.settings.syncFileExtensions.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.syncFileExtensions = value
							.split(",")
							.map((e) => e.trim().toLowerCase().replace(/^\./, ""))
							.filter(Boolean);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Maintenance").setHeading();

		new Setting(containerEl)
			.setName("Reset sync state")
			.setDesc(
				"Forgets which revision each note was last synced at. Nothing is deleted, but the next sync treats every difference as a conflict.",
			)
			.addButton((button) =>
				button
					.setButtonText("Reset")
					.setWarning()
					.onClick(async () => {
						await this.plugin.resetState();
						new Notice("Sync state cleared.");
					}),
			);
	}

	/** Top-level vault folders that aren't synced yet, each offered as a collection. */
	private displayLocalFolders(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;
		const topLevel = this.app.vault
			.getRoot()
			.children.filter((child): child is TFolder => child instanceof TFolder)
			.map((folder) => folder.name);
		const plan = planLocalFolders(topLevel, this.collections, settings.mappings, [settings.attachmentFolder]);

		new Setting(containerEl).setName("Vault folders not in Outline").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				plan.length === 0
					? "Every top-level folder in this vault is already synced."
					: "Turn a top-level folder into an Outline collection. Its notes, subfolders and allow-listed files upload on the next sync.",
		});

		const extensions = new Set(settings.syncFileExtensions.map((e) => e.toLowerCase()));
		for (const { folder, existing } of plan) {
			const inside = this.app.vault.getFiles().filter((file) => isInsideFolder(file.path, folder));
			const notes = inside.filter((file) => file.extension === "md").length;
			const files = inside.filter((file) => extensions.has(file.extension.toLowerCase())).length;
			const counts = `${notes} note${notes === 1 ? "" : "s"}${files ? `, ${files} file${files === 1 ? "" : "s"}` : ""}`;

			new Setting(containerEl)
				.setName(folder)
				.setDesc(existing ? `${counts} · Outline already has a collection named "${existing.name}"` : counts)
				.addButton((button) =>
					button.setButtonText(existing ? "Sync with existing" : "Create collection").onClick(async () => {
						const choice = await new FolderConfirmModal(this.app, {
							folder,
							notes,
							files,
							existing: existing?.name,
							uploadsNewNotes: settings.createRemoteForNewFiles,
						}).openAndWait();
						if (choice === "cancel") return;

						button.setDisabled(true).setButtonText(existing ? "Linking…" : "Creating…");
						try {
							let collection = existing;
							if (!collection) {
								const client = new OutlineClient(settings.baseUrl, settings.apiToken);
								collection = await client.createCollection({ name: folder, private: choice === "private" });
								this.collections.push(collection);
							}
							settings.mappings.push({ collectionId: collection.id, collectionName: collection.name, folder });
							await this.plugin.saveSettings();
							new Notice(`Outline Sync: "${folder}" is now synced with "${collection.name}". Uploading…`);
							this.display();
							void this.plugin.syncNow();
						} catch (error) {
							new Notice(`Could not set up "${folder}": ${String(error)}`, 10_000);
							button.setDisabled(false).setButtonText(existing ? "Sync with existing" : "Create collection");
						}
					}),
				);
		}
	}
}
