import { AbstractInputSuggest, Notice, PluginSettingTab, Setting, TextComponent, ToggleComponent, TFolder, type App } from "obsidian";

import { OutlineClient } from "../outline/client";
import type OutlineSyncPlugin from "../main";

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	private inputEl: HTMLInputElement;

	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
		this.inputEl = inputEl;
	}

	getSuggestions(inputStr: string): TFolder[] {
		const lower = inputStr.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder)
			.filter((folder) => folder.path.toLowerCase().includes(lower));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.inputEl.value = folder.path;
		this.inputEl.dispatchEvent(new Event("input"));
		this.close();
	}
}


function trimSlashes(value: string): string {
	let folder = value.trim();
	while (folder.startsWith("/")) folder = folder.slice(1);
	while (folder.endsWith("/")) folder = folder.slice(0, -1);
	return folder;
}

import type { ConflictPolicy, OutlineCollection } from "../types";

export class OutlineSyncSettingTab extends PluginSettingTab {
	private collections: OutlineCollection[] = [];
	private advancedOpen = new Set<string>();

	constructor(
		app: App,
		private readonly plugin: OutlineSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const version = new Setting(containerEl)
			.setName("Outline Sync")
			.setDesc(`Version ${this.plugin.manifest.version}`);
		version.descEl.createEl("br");
		version.descEl.createEl("a", {
			text: "Check for the latest release",
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
			const isEnabled = Boolean(mapping);
			const isOpen = isEnabled && this.advancedOpen.has(collection.id);

			// One setting item. Advanced fields are appended inside it so the
			// card grows instead of spawning a second row in the settings list.
			const row = new Setting(containerEl).setName(collection.name);
			row.settingEl.addClass("outline-sync-collection");
			if (isOpen) row.settingEl.addClass("is-open");

			row.controlEl.createSpan({
				text: "Enable:",
				cls: "outline-sync-enable-label",
			});

			row.addToggle((toggle) =>
				toggle.setValue(isEnabled).onChange(async (enabled) => {
					if (enabled) {
						this.plugin.settings.mappings.push({
							collectionId: collection.id,
							collectionName: collection.name,
							folder: collection.name,
							suppressByDefault: false,
						});
					} else {
						this.plugin.settings.mappings = this.plugin.settings.mappings.filter(
							(candidate) => candidate.collectionId !== collection.id,
						);
						this.advancedOpen.delete(collection.id);
					}
					await this.plugin.saveSettings();
					this.display();
				}),
			);

			// Always reserve the caret slot so a disabled collection's toggle
			// lines up with one that has the caret showing.
			row.addExtraButton((btn) => {
				btn.setIcon(isOpen ? "chevron-up" : "chevron-down");
				if (!isEnabled) {
					btn.extraSettingsEl.addClass("outline-sync-caret-slot");
					btn.extraSettingsEl.ariaHidden = "true";
					return;
				}
				btn.setTooltip(isOpen ? "Hide advanced settings" : "Show advanced settings").onClick(() => {
					if (this.advancedOpen.has(collection.id)) {
						this.advancedOpen.delete(collection.id);
					} else {
						this.advancedOpen.add(collection.id);
					}
					this.display();
				});
			});

			if (isOpen && mapping) {
				const panel = row.settingEl.createDiv({ cls: "outline-sync-collection-advanced" });

				const folderGroup = panel.createDiv({ cls: "outline-sync-advanced-folder" });
				folderGroup.createSpan({ text: "Local folder:", cls: "outline-sync-advanced-label" });
				const folderInput = new TextComponent(folderGroup)
					.setPlaceholder("Vault folder")
					.setValue(mapping.folder);
				folderInput.inputEl.addClass("outline-sync-folder-input");
				folderInput.onChange(async (value) => {
					const current = this.plugin.settings.mappings.find(
						(candidate) => candidate.collectionId === collection.id,
					);
					if (!current) return;
					current.folder = trimSlashes(value);
					await this.plugin.saveSettings();
				});
				new FolderSuggest(this.app, folderInput.inputEl);

				const syncGroup = panel.createDiv({ cls: "outline-sync-advanced-sync" });
				syncGroup.createSpan({
					text: "Local Files Always Sync:",
					cls: "outline-sync-advanced-label",
				});
				new ToggleComponent(syncGroup)
					.setValue(!mapping.suppressByDefault)
					.setTooltip(
						"On: new notes sync unless you suppress them. Off: new notes stay local until you turn sync on.",
					)
					.onChange(async (value) => {
						const current = this.plugin.settings.mappings.find(
							(candidate) => candidate.collectionId === collection.id,
						);
						if (!current) return;
						current.suppressByDefault = !value;
						await this.plugin.saveSettings();
					});
			}
		}

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
						local: "Keep local version",
						remote: "Keep remote version",
						newer: "Keep the newer version",
					})
					.setValue(this.plugin.settings.conflictPolicy)
					.onChange(async (value) => {
						this.plugin.settings.conflictPolicy = value as ConflictPolicy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Attachment folder")
			.setDesc("Downloaded images and attachments will be saved here (relative to vault root).")
			.addText((text) =>
				text
					.setPlaceholder("Outline Attachments")
					.setValue(this.plugin.settings.attachmentFolder)
					.onChange(async (value) => {
						this.plugin.settings.attachmentFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Create remote documents for new local files")
			.setDesc("When a new note appears in a mapped folder, automatically create it in Outline.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.createRemoteForNewFiles).onChange(async (value) => {
					this.plugin.settings.createRemoteForNewFiles = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Propagate local deletes")
			.setDesc("When you delete a note locally, also delete the corresponding document in Outline.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.propagateLocalDeletes).onChange(async (value) => {
					this.plugin.settings.propagateLocalDeletes = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Propagate remote deletes")
			.setDesc("When a document is deleted in Outline, move the local note to the Obsidian trash.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.propagateRemoteDeletes).onChange(async (value) => {
					this.plugin.settings.propagateRemoteDeletes = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Convert markdown between Obsidian and Outline")
			.setDesc("Preserve soft line breaks and use Obsidian's list/bullet style. Turn off to exchange raw markdown.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.convertMarkdown).onChange(async (value) => {
					this.plugin.settings.convertMarkdown = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Sync non-markdown files as attachments")
			.setDesc("File extensions (without dot) that should be uploaded as attachments. Example: html,pdf")
			.addText((text) =>
				text
					.setPlaceholder("html,pdf")
					.setValue(this.plugin.settings.syncFileExtensions.join(","))
					.onChange(async (value) => {
						this.plugin.settings.syncFileExtensions = value
							.split(",")
							.map((e) => e.trim().toLowerCase())
							.filter(Boolean);
						await this.plugin.saveSettings();
					}),
			);
	}
}