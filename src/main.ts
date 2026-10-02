import { Notice, Plugin, TFile, debounce, setIcon, setTooltip } from "obsidian";

import { OutlineClient } from "./outline/client";
import { SyncEngine, type Conflict, type Resolution, type SyncDirection } from "./sync/engine";
import { isInsideFolder, parentFolderOf } from "./sync/paths";
import { isOutlineSuppressed, parseNote, withFrontmatter } from "./sync/markdown";
import { SyncStateStore, emptyState } from "./sync/state";
import { DEFAULT_SETTINGS, type OutlineSyncSettings, type SyncState, type SyncSummary } from "./types";
import { ConflictModal } from "./ui/conflict-modal";
import { OutlineSyncSettingTab } from "./ui/settings-tab";

interface PersistedData {
	settings: OutlineSyncSettings;
	state: SyncState;
}

export default class OutlineSyncPlugin extends Plugin {
	settings: OutlineSyncSettings = { ...DEFAULT_SETTINGS };
	private state = new SyncStateStore();
	private engine?: SyncEngine;
	private statusBar?: HTMLElement;
	private statusText?: HTMLElement;
	private pullButton?: HTMLElement;
	private pushButton?: HTMLElement;
	private pollHandle?: number;
	/** Debounced push, rebuilt when the interval setting changes. */
	private flushDebounced: () => void = () => undefined;
	/** Notes edited locally and waiting for the debounce to expire. */
	private readonly pendingPushes = new Set<string>();
	/** A folder move happened; the next flush must run a full sync to propagate it. */
	private pendingFullSync = false;
	/** Serialises syncs so overlapping runs can't create duplicate documents. */
	private syncing = false;
	/** Paths whose next modify event is our own checkbox backfill. */
	private readonly backfillWrites = new Set<string>();

	async onload(): Promise<void> {
		await this.loadPersisted();
		this.registerSuppressionProperty();
		this.addSettingTab(new OutlineSyncSettingTab(this.app, this));

		this.buildStatusBar();

		this.addRibbonIcon("refresh-cw", "Sync with Outline", () => void this.syncNow());

		this.addCommand({
			id: "sync-now",
			name: "Sync with Outline now",
			callback: () => void this.syncNow(),
		});
		this.addCommand({
			id: "pull-from-outline",
			name: "Pull from Outline (Outline → vault)",
			callback: () => void this.runSync("pull"),
		});
		this.addCommand({
			id: "push-to-outline",
			name: "Push to Outline (vault → Outline)",
			callback: () => void this.runSync("push"),
		});
		this.addCommand({
			id: "push-active-note",
			name: "Push the active note to Outline",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.pushFile(file);
				return true;
			},
		});
		this.addCommand({
			id: "open-in-outline",
			name: "Open the active note in Outline",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const record = file ? this.state.byPath(file.path) : undefined;
				if (!record || !this.settings.baseUrl) return false;
				if (!checking) window.open(`${this.settings.baseUrl}/doc/${record.documentId}`, "_blank");
				return true;
			},
		});

		this.addCommand({
			id: "toggle-outline-suppression",
			name: "Toggle Outline suppression for active note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.toggleNoteSuppression(file);
				return true;
			},
		});

		this.registerVaultEvents();

		this.app.workspace.onLayoutReady(() => {
			void this.prepareAndStart();
		});
	}

	onunload(): void {
		this.clearPolling();
	}

	private async prepareAndStart(): Promise<void> {
		await this.backfillSuppressionProperty();
		this.restartPolling();
		if (this.settings.syncOnStartup && this.isConfigured()) void this.syncNow(true);
	}

	/**
	 * Notes synced before this property existed have no checkbox. Add an
	 * unchecked one so the user can opt out later, without changing what
	 * already syncs. New notes still follow the folder default.
	 */
	private async backfillSuppressionProperty(): Promise<void> {
		const folders = this.settings.mappings.map((mapping) => mapping.folder).filter(Boolean);
		if (folders.length === 0) return;

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!folders.some((folder) => isInsideFolder(file.path, folder))) continue;
			const content = await this.app.vault.read(file);
			if ("outlineSuppressed" in parseNote(content).frontmatter) continue;

			this.backfillWrites.add(file.path);
			await this.app.vault.modify(file, withFrontmatter(content, { outlineSuppressed: false }));
		}
	}

	private isConfigured(): boolean {
		return Boolean(this.settings.baseUrl && this.settings.apiToken && this.settings.mappings.length);
	}

	private getEngine(): SyncEngine {
		// Rebuilt on demand so a settings change takes effect without a reload.
		const client = new OutlineClient(this.settings.baseUrl, this.settings.apiToken);
		this.engine = new SyncEngine(
			this.app,
			client,
			this.state,
			this.settings,
			{
				resolveConflicts: (conflicts) => this.askAboutConflicts(conflicts),
				onStatus: (message) => this.setStatus(`Outline: ${message}`),
				onError: (message) => new Notice(message, 10_000),
			},
			() => this.savePersisted(),
		);
		return this.engine;
	}

	/** Bidirectional sync — used by the ribbon, polling and startup. */
	async syncNow(quiet = false): Promise<void> {
		await this.runSync("both", quiet);
	}

	/** Runs a sync in one direction. The status-bar buttons call this. */
	async runSync(direction: SyncDirection, quiet = false): Promise<void> {
		if (!this.isConfigured()) {
			if (!quiet) new Notice("Outline Sync: set the URL, token and at least one folder in settings first.");
			return;
		}
		// A fresh engine is built per call, so its own isRunning flag can't guard
		// against overlapping syncs (button + poll + file-event). Serialise here,
		// or two runs create duplicate documents for the same new file.
		if (this.syncing) return;
		this.syncing = true;
		const engine = this.getEngine();

		const verb = direction === "pull" ? "pulling" : direction === "push" ? "pushing" : "syncing";
		this.setBusy(true);
		this.setStatus(`Outline: ${verb}…`);
		try {
			const summary = await engine.syncAll(direction);
			this.reportSummary(summary, quiet);
		} catch (error) {
			this.setStatus("Outline: failed", true);
			new Notice(`Outline sync failed: ${String(error)}`, 10_000);
			return;
		} finally {
			this.syncing = false;
			this.setBusy(false);
		}
		const done = direction === "pull" ? "pulled" : direction === "push" ? "pushed" : "synced";
		this.setStatus(`Outline: ${done} ${timeOfDay()}`);
	}

	private async pushFile(file: TFile): Promise<void> {
		if (!this.isConfigured() || this.syncing) return;
		try {
			const outcome = await this.getEngine().pushNote(file);
			if (outcome === "pushed") this.setStatus(`Outline: pushed ${timeOfDay()}`);
			if (outcome === "skipped" && !this.state.byPath(file.path)) {
				// Not yet a document: a full sync is what creates it.
				await this.syncNow(true);
			}
		} catch (error) {
			this.setStatus("Outline: push failed", true);
			new Notice(`Could not push ${file.basename}: ${String(error)}`, 10_000);
		}
	}

	private async toggleNoteSuppression(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		const parsed = parseNote(content);
		const currentlySuppressed = isOutlineSuppressed(parsed.frontmatter);
		const nextSuppressed = !currentlySuppressed;

		const updates: Record<string, unknown> = { outlineSuppressed: nextSuppressed };

		// Stamp last sync time when we are enabling suppression on a previously synced note
		if (!currentlySuppressed && parsed.frontmatter.outlineId) {
			updates.outlineLastsync = new Date().toISOString();
		}

		const updated = withFrontmatter(content, updates);
		await this.app.vault.modify(file, updated);
		new Notice(
			currentlySuppressed
				? "Outline suppression removed; note will sync."
				: "Note suppressed from Outline sync.",
		);
	}

	private async onTrackedNoteCreated(file: TFile): Promise<void> {
		await this.applyFolderDefaultSuppression(file);
		if (!this.autoPushEnabled() || !this.settings.createRemoteForNewFiles) return;

		const content = await this.app.vault.read(file);
		if (isOutlineSuppressed(parseNote(content).frontmatter)) return;
		this.pendingPushes.add(file.path);
		this.flushDebounced();
	}

	private async applyFolderDefaultSuppression(file: TFile): Promise<void> {
		const mapping = this.settings.mappings.find((m) => isInsideFolder(file.path, m.folder));
		if (!mapping) return;

		const content = await this.app.vault.read(file);
		const parsed = parseNote(content);
		// Leave an explicit choice alone. A note the engine just created already
		// carries outlineId and gets an unchecked box from writeNote.
		if ("outlineSuppressed" in parsed.frontmatter) return;

		const updated = withFrontmatter(content, {
			outlineSuppressed: Boolean(mapping.suppressByDefault),
		});
		await this.app.vault.modify(file, updated);
	}

	/** So the property shows up as a checkbox instead of free text. */
	private registerSuppressionProperty(): void {
		const manager = (
			this.app as unknown as {
				metadataTypeManager?: { setType?: (key: string, type: string) => void };
			}
		).metadataTypeManager;
		manager?.setType?.("outlineSuppressed", "checkbox");
	}

	private async askAboutConflicts(conflicts: Conflict[]): Promise<Map<string, Resolution>> {
		new Notice(
			`Outline Sync: ${conflicts.length} note(s) changed in both places.`,
			6000,
		);
		return new ConflictModal(this.app, conflicts).openAndWait();
	}

	/** True when local edits push automatically; false is "manual only". */
	private autoPushEnabled(): boolean {
		return this.settings.pushDebounceMs > 0;
	}

	/**
	 * (Re)builds the debounced push. Called on load and whenever the interval
	 * setting changes, so the change takes effect without reloading Obsidian.
	 */
	rebuildPushDebounce(): void {
		this.flushDebounced = this.autoPushEnabled()
			? debounce(() => void this.flushPendingPushes(), this.settings.pushDebounceMs, true)
			: () => undefined;
	}

	private registerVaultEvents(): void {
		this.rebuildPushDebounce();

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && this.backfillWrites.delete(file.path)) return;
				if (!(file instanceof TFile) || !this.autoPushEnabled()) return;
				if (file.extension === "md") {
					if (this.isTracked(file.path)) void this.queuePush(file, this.flushDebounced);
				} else if (this.isSyncableFile(file)) {
					// A non-markdown file change needs the full file-sync pass.
					this.pendingFullSync = true;
					this.flushDebounced();
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!(file instanceof TFile)) return;
				if (file.extension === "md" && this.isTracked(file.path)) {
					void this.onTrackedNoteCreated(file);
				} else if (this.isSyncableFile(file)) {
					this.pendingFullSync = true;
					this.flushDebounced();
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				// Relocate the record even in manual mode, so the rename is not lost.
				const record = this.state.relocate(oldPath, file.path);
				if (!record) return;
				void this.savePersisted();
				if (!this.autoPushEnabled()) return;
				// A move to a different folder must re-parent the document in Outline,
				// which only the full reconcile does — request one.
				if (parentFolderOf(oldPath) !== parentFolderOf(file.path)) this.pendingFullSync = true;
				// The title lives in the filename, so a rename is an edit.
				this.pendingPushes.add(file.path);
				this.flushDebounced();
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file instanceof TFile)) return;
				const record = this.state.byPath(file.path);
				if (!record) return;
				if (this.settings.propagateLocalDeletes) {
					void this.deleteRemote(record.documentId, file.basename);
				}
				this.state.remove(record.documentId);
				void this.savePersisted();
			}),
		);
	}

	private async deleteRemote(documentId: string, title: string): Promise<void> {
		try {
			await new OutlineClient(this.settings.baseUrl, this.settings.apiToken).deleteDocument(documentId);
			new Notice(`Deleted "${title}" in Outline.`);
		} catch (error) {
			new Notice(`Could not delete "${title}" in Outline: ${String(error)}`, 10_000);
		}
	}

	private async queuePush(file: TFile, flush: () => void): Promise<void> {
		// Ignore the modify event our own pull just caused.
		const content = await this.app.vault.read(file);
		if (this.engine?.isSelfWrite(file.path, content)) return;
		this.pendingPushes.add(file.path);
		flush();
	}

	private async flushPendingPushes(): Promise<void> {
		if (!this.isConfigured()) return;
		const paths = [...this.pendingPushes];
		this.pendingPushes.clear();

		let needsFullSync = this.pendingFullSync;
		this.pendingFullSync = false;
		for (const path of paths) {
			const file = this.app.vault.getFileByPath(path);
			if (!file) continue;
			if (!this.state.byPath(path)) {
				needsFullSync = true;
				continue;
			}
			await this.pushFile(file);
		}
		if (needsFullSync) await this.syncNow(true);
	}

	/** A non-markdown file in a mapped folder whose extension is allow-listed. */
	private isSyncableFile(file: TFile): boolean {
		const ext = (file.extension ?? file.path.split(".").pop() ?? "").toLowerCase();
		return (
			this.settings.syncFileExtensions.some((e) => e.toLowerCase().replace(/^\./, "") === ext) &&
			this.isTracked(file.path)
		);
	}

	private isTracked(path: string): boolean {
		return this.settings.mappings.some((mapping) => isInsideFolder(path, mapping.folder));
	}

	restartPolling(): void {
		this.clearPolling();
		const seconds = this.settings.pollIntervalSeconds;
		if (seconds <= 0) return;
		this.pollHandle = window.setInterval(() => {
			if (this.isConfigured()) void this.syncNow(true);
		}, seconds * 1000);
		this.registerInterval(this.pollHandle);
	}

	private clearPolling(): void {
		if (this.pollHandle !== undefined) {
			window.clearInterval(this.pollHandle);
			this.pollHandle = undefined;
		}
	}

	private reportSummary(summary: SyncSummary, quiet: boolean): void {
		const parts: string[] = [];
		if (summary.pulled) parts.push(`${summary.pulled} pulled`);
		if (summary.pushed) parts.push(`${summary.pushed} pushed`);
		if (summary.created) parts.push(`${summary.created} created`);
		if (summary.deleted) parts.push(`${summary.deleted} removed`);
		if (summary.conflicts > 0) parts.push(`${summary.conflicts} unresolved`);

		for (const error of summary.errors.slice(0, 3)) new Notice(`Outline Sync: ${error}`, 10_000);
		if (summary.errors.length > 3) {
			new Notice(`Outline Sync: ${summary.errors.length - 3} more problem(s).`, 8000);
		}
		if (parts.length > 0 && !quiet) new Notice(`Outline Sync: ${parts.join(", ")}.`);
		if (parts.length === 0 && !quiet) new Notice("Outline Sync: already up to date.");
	}

	private buildStatusBar(): void {
		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("outline-sync-statusbar");

		this.pullButton = this.addStatusButton(
			"download",
			"Pull from Outline (Outline → vault)",
			() => void this.runSync("pull"),
		);
		this.pushButton = this.addStatusButton(
			"upload",
			"Push to Outline (vault → Outline)",
			() => void this.runSync("push"),
		);
		this.statusText = this.statusBar.createSpan({ cls: "outline-sync-status-text" });
		this.setStatus("Outline: idle");
	}

	private addStatusButton(icon: string, tooltip: string, onClick: () => void): HTMLElement {
		const button = this.statusBar!.createSpan({ cls: "outline-sync-status-btn" });
		setIcon(button, icon);
		setTooltip(button, tooltip, { placement: "top" });
		button.setAttribute("aria-label", tooltip);
		this.registerDomEvent(button, "click", () => {
			if (button.hasClass("is-busy")) return;
			onClick();
		});
		return button;
	}

	/** Disables the buttons and shows a spin while a sync is in flight. */
	private setBusy(busy: boolean): void {
		for (const button of [this.pullButton, this.pushButton]) {
			button?.toggleClass("is-busy", busy);
		}
	}

	private setStatus(message: string, isError = false): void {
		this.statusText?.setText(message);
		this.statusBar?.toggleClass("outline-sync-status-error", isError);
	}

	private async loadPersisted(): Promise<void> {
		const data = (await this.loadData()) as Partial<PersistedData> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
		this.state = new SyncStateStore(data?.state);
	}

	async saveSettings(): Promise<void> {
		await this.savePersisted();
	}

	private async savePersisted(): Promise<void> {
		await this.saveData({ settings: this.settings, state: this.state.toJSON() } satisfies PersistedData);
	}

	async resetState(): Promise<void> {
		this.state = new SyncStateStore(emptyState());
		await this.savePersisted();
	}
}

function timeOfDay(): string {
	return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
