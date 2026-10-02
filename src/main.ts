import { Notice, Plugin, TFile, TFolder, debounce, normalizePath, setIcon, setTooltip } from "obsidian";

import { OutlineClient } from "./outline/client";
import { SyncEngine, type Conflict, type Resolution, type SyncDirection } from "./sync/engine";
import { isInsideFolder, parentFolderOf, renamedPath } from "./sync/paths";
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
	/** Local notes deleted recently, by document id → title; handled after a short settle. */
	private readonly pendingLocalDeletes = new Map<string, string>();
	private localDeleteTimer?: number;
	/** Serialises syncs so overlapping runs can't create duplicate documents. */
	private syncing = false;
	/** A sync asked for while another was running; it runs right after. */
	private queuedSync?: { direction: SyncDirection; quiet: boolean };

	async onload(): Promise<void> {
		await this.loadPersisted();
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

		this.registerVaultEvents();

		this.app.workspace.onLayoutReady(() => {
			this.restartPolling();
			if (this.settings.syncOnStartup && this.isConfigured()) void this.syncNow(true);
		});
	}

	onunload(): void {
		this.clearPolling();
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
		if (this.syncing) {
			// Don't drop the request silently — run it as soon as this one ends.
			const queued = this.queuedSync;
			this.queuedSync = {
				direction: queued && queued.direction !== direction ? "both" : direction,
				quiet: (queued?.quiet ?? true) && quiet,
			};
			if (!quiet) new Notice("Outline Sync: a sync is already running — yours will run right after it.");
			return;
		}
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
			const queued = this.queuedSync;
			this.queuedSync = undefined;
			if (queued) window.setTimeout(() => void this.runSync(queued.direction, queued.quiet), 0);
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

	private async askAboutConflicts(conflicts: Conflict[]): Promise<Map<string, Resolution>> {
		new Notice(
			`Outline Sync: ${conflicts.length} note(s) changed in both places.`,
			6000,
		);
		this.setStatus("Outline: waiting for your decision");
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
				if (!(file instanceof TFile) || !this.autoPushEnabled()) return;
				if (file.extension === "md") {
					if (this.isTracked(file.path) && this.settings.createRemoteForNewFiles) {
						this.pendingPushes.add(file.path);
						this.flushDebounced();
					}
				} else if (this.isSyncableFile(file)) {
					this.pendingFullSync = true;
					this.flushDebounced();
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFolder) {
					this.followFolderRename(oldPath, file.path);
					return;
				}
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
				// Decide a moment later, once the vault has settled: a whole synced
				// folder being deleted fires one event per note, and that must stop
				// syncing the folder rather than delete every note in Outline.
				this.pendingLocalDeletes.set(record.documentId, file.basename);
				window.clearTimeout(this.localDeleteTimer);
				this.localDeleteTimer = window.setTimeout(() => void this.processLocalDeletes(), 1500);
			}),
		);
	}

	/**
	 * A folder was renamed or moved in Obsidian. Synced folders keep syncing under
	 * their new name, and every note inside keeps its link to its document.
	 */
	private followFolderRename(oldPath: string, newPath: string): void {
		let changed = this.state.relocateFolder(oldPath, newPath) > 0;
		for (const mapping of this.settings.mappings) {
			const next = renamedPath(mapping.folder, oldPath, newPath);
			if (next !== undefined && next !== mapping.folder) {
				mapping.folder = next;
				changed = true;
				new Notice(`Outline Sync: "${oldPath}" is now "${next}" — still synced with "${mapping.collectionName}".`);
			}
		}
		if (changed) void this.savePersisted();
	}

	private async processLocalDeletes(): Promise<void> {
		const pending = [...this.pendingLocalDeletes];
		this.pendingLocalDeletes.clear();
		let folderGone = false;
		for (const [documentId, title] of pending) {
			const record = this.state.get(documentId);
			if (!record || this.app.vault.getAbstractFileByPath(record.path)) continue; // gone already, or back
			const mapping = this.settings.mappings.find((candidate) => candidate.collectionId === record.collectionId);
			const folder = mapping?.folder.replace(/^\/+|\/+$/g, "");
			// The synced folder itself is gone: leave its records, so the next sync
			// sees the folder disappear and stops syncing it without touching Outline.
			if (folder && !this.app.vault.getAbstractFileByPath(normalizePath(folder))) {
				folderGone = true;
				continue;
			}
			if (this.settings.propagateLocalDeletes) await this.deleteRemote(documentId, title);
			this.state.remove(documentId);
		}
		await this.savePersisted();
		if (folderGone) void this.syncNow(true); // unlinks the folder now rather than at the next check
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
		// 0.7.1 made 10 s the default for both checking and pushing. Move only people
		// still on an earlier default; anyone who chose an interval keeps it.
		if (data?.settings && (data.settings.settingsVersion ?? 0) < 2) {
			if ([3000, 60_000].includes(this.settings.pushDebounceMs)) this.settings.pushDebounceMs = 10_000;
			if (this.settings.pollIntervalSeconds === 60) this.settings.pollIntervalSeconds = 10;
			this.settings.settingsVersion = 2;
			await this.saveData({ settings: this.settings, state: data.state ?? emptyState() });
		}
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
