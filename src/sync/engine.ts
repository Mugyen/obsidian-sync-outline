import { normalizePath, TFile, type App } from "obsidian";

import { OutlineApiError, OutlineClient } from "../outline/client";
import type {
	CollectionMapping,
	ConflictPolicy,
	OutlineSyncSettings,
	RemoteDocument,
	SyncRecord,
	SyncSummary,
} from "../types";
import {
	buildFileWrapper,
	contentTypeForPath,
	decodeFromOutline,
	encodeForOutline,
	extensionForContentType,
	findLocalImages,
	findOutlineAttachments,
	hashBody,
	hashBytes,
	isFileWrapper,
	parseFileWrapper,
	parseNote,
	rewriteAttachmentsToLocal,
	rewriteImageToOutline,
	withFrontmatter,
} from "./markdown";
import {
	FOLDER_PLACEHOLDER_BODY,
	childFolderFor,
	isFolderPlaceholder,
	isInsideFolder,
	parentFolderOf,
	pathForDocument,
	safeFileName,
	titleFromPath,
	withSuffix,
} from "./paths";
import type { SyncStateStore } from "./state";

export interface Conflict {
	record: SyncRecord;
	path: string;
	localBody: string;
	remote: RemoteDocument;
	/** Remote text with attachment links pointed at local files, for display and for "keep remote". */
	remoteBody: string;
}

export type Resolution = "local" | "remote" | "both" | "skip";

/** Which automatic writes a sync performs. Conflicts are asked in every case. */
export type SyncDirection = "both" | "pull" | "push";

export interface EngineHooks {
	/** Asks how to resolve conflicts the policy could not settle on its own. */
	resolveConflicts(conflicts: Conflict[]): Promise<Map<string, Resolution>>;
	onStatus(message: string): void;
	onError(message: string): void;
}

interface LocalNote {
	file: TFile;
	path: string;
	body: string;
	outlineId?: string;
	hash: string;
}

export class SyncEngine {
	/** Content we wrote ourselves, so the vault's modify event can ignore it. */
	private readonly selfWrites = new Map<string, string>();
	private running = false;
	private rerunRequested = false;

	constructor(
		private readonly app: App,
		private readonly client: OutlineClient,
		private readonly state: SyncStateStore,
		private readonly settings: OutlineSyncSettings,
		private readonly hooks: EngineHooks,
		private readonly persist: () => Promise<void>,
	) {}

	get isRunning(): boolean {
		return this.running;
	}

	/** True when a modify event was caused by this plugin's own write. */
	isSelfWrite(path: string, content: string): boolean {
		const expected = this.selfWrites.get(path);
		if (expected === undefined) return false;
		if (expected !== hashBody(parseNote(content).body)) return false;
		this.selfWrites.delete(path);
		return true;
	}

	async syncAll(direction: SyncDirection = "both"): Promise<SyncSummary> {
		if (this.running) {
			this.rerunRequested = true;
			return emptySummary();
		}
		this.running = true;
		const summary = emptySummary();

		// A directional sync still reads both sides (to reconcile and to detect
		// conflicts) but only performs the automatic writes for its direction.
		// Conflicts are surfaced in every direction — a directional button never
		// silently overwrites the other side.
		const doPull = direction !== "push";
		const doPush = direction !== "pull";

		try {
			const mappings = this.settings.mappings.filter((mapping) => mapping.collectionId && mapping.folder);
			if (mappings.length === 0) {
				this.hooks.onError("No collections mapped to folders yet.");
				return summary;
			}

			this.hooks.onStatus("Fetching Outline…");
			const remoteById = new Map<string, RemoteDocument>();
			const folderByCollection = new Map<string, string>();
			for (const mapping of mappings) {
				folderByCollection.set(mapping.collectionId, mapping.folder);
				for (const document of await this.client.listDocuments(mapping.collectionId)) {
					remoteById.set(document.id, document);
				}
			}

			const localNotes = await this.scanVault(mappings.map((mapping) => mapping.folder));
			const localById = new Map<string, LocalNote>();
			for (const note of localNotes) {
				if (note.outlineId) localById.set(note.outlineId, note);
			}

			const conflicts: Conflict[] = [];

			for (const remote of remoteById.values()) {
				const folder = folderByCollection.get(remote.collectionId);
				if (!folder) continue;
				const desiredPath = pathForDocument(remote, remoteById, folder);

				// A folder placeholder is inert: mirror it as a bare folder and
				// never write a note for it or pull its edits.
				if (isFolderPlaceholder(remote.text)) {
					if (doPull) await this.adoptRemoteFolder(remote, desiredPath);
					continue;
				}

				// A file document wraps a non-markdown file; handled by syncFiles.
				if (isFileWrapper(remote.text)) continue;

				const record = this.state.get(remote.id);
				const local = localById.get(remote.id) ?? (record ? this.noteAt(localNotes, record.path) : undefined);

				try {
					if (!local) {
						// New to this vault, or the note was deleted locally. Outline
						// decides existence, so it comes back.
						if (doPull) {
							await this.pull(remote, desiredPath, record);
							summary.pulled++;
						}
						continue;
					}

					if (!record) {
						// A note carrying an outlineId we have no base for: adopt it if
						// the text already matches, otherwise it is a genuine conflict.
						if (local.hash === hashBody(this.toLocalBody(remote, local.path))) {
							this.recordAgreement(remote, local.path, local.hash);
						} else {
							conflicts.push(await this.buildConflict(this.provisionalRecord(remote, local.path), local, remote));
						}
						continue;
					}

					// A rename in Obsidian changes the note's title without touching its
					// body. Treat that as a local edit so it is pushed to Outline —
					// otherwise the relocate below would rename the file back to match
					// the stale remote title and discard the user's rename.
					const titleChangedLocally = titleFromPath(local.path) !== record.title;
					const localChanged = local.hash !== record.baseHash || titleChangedLocally;
					const remoteChanged = this.remoteHasChanged(remote, record);

					// The note sits in a different folder than Outline's nesting says,
					// and Outline's parent has not moved since we agreed — so the user
					// moved it locally. Propagate the move; never revert it.
					const folderMovedLocally =
						(remote.parentDocumentId ?? "") === (record.parentDocumentId ?? "") &&
						parentFolderOf(local.path) !== parentFolderOf(desiredPath);

					if (folderMovedLocally && !remoteChanged) {
						if (doPush) {
							if (localChanged) await this.push(record, local);
							await this.moveRemote(record, local, remoteById, folderByCollection);
							summary.pushed++;
						}
						continue;
					}

					if (!localChanged && !remoteChanged) {
						// Relocate to match Outline only when the remote actually moved —
						// never when the user just moved the note locally.
						if (doPull && local.path !== desiredPath && !folderMovedLocally) {
							await this.relocateNote(local, desiredPath, record);
						}
						continue;
					}
					if (localChanged && !remoteChanged) {
						if (doPush) {
							await this.push(record, local);
							summary.pushed++;
						}
					} else if (!localChanged && remoteChanged) {
						if (doPull) {
							await this.pull(remote, local.path === desiredPath ? local.path : desiredPath, record);
							summary.pulled++;
						}
					} else {
						conflicts.push(await this.buildConflict(record, local, remote));
					}
				} catch (error) {
					summary.errors.push(describe(error, remote.title));
				}
			}

			// Local notes Outline has never seen. Creating them is a push.
			if (doPush && this.settings.createRemoteForNewFiles) {
				for (const note of localNotes) {
					if (note.outlineId) continue;
					const mapping = mappings.find((candidate) => isInsideFolder(note.path, candidate.folder));
					if (!mapping) continue;
					try {
						await this.create(note, mapping.collectionId, remoteById, folderByCollection);
						summary.created++;
					} catch (error) {
						summary.errors.push(describe(error, note.path));
					}
				}
			}

			// Documents we have a record for that are gone from Outline. Trashing
			// the local note is a local write, so it belongs to pull.
			for (const record of doPull ? this.state.all() : []) {
				if (remoteById.has(record.documentId)) continue;
				if (!folderByCollection.has(record.collectionId)) continue;
				// A vanished folder placeholder just drops its record; its local
				// folder is left alone (its notes are reconciled on their own).
				if (record.isFolder) {
					this.state.remove(record.documentId);
					continue;
				}
				try {
					// Absent from the listing is not proof of deletion — a partial
					// page or an unexpected server-side filter would otherwise trash
					// a live note. Only trash when Outline confirms it is gone.
					if (await this.client.getDocument(record.documentId)) continue;
					await this.handleRemoteDeletion(record);
					summary.deleted++;
				} catch (error) {
					summary.errors.push(describe(error, record.title));
				}
			}

			// Non-markdown files sync as attachment-wrapped "file documents".
			await this.syncFiles(mappings, remoteById, folderByCollection, summary, doPull, doPush);

			if (conflicts.length > 0) {
				summary.conflicts = conflicts.length;
				await this.applyResolutions(conflicts, summary);
			}

			this.state.markSynced();
			await this.persist();
		} finally {
			this.running = false;
		}

		if (this.rerunRequested) {
			this.rerunRequested = false;
			const followUp = await this.syncAll(direction);
			return mergeSummaries(summary, followUp);
		}
		return summary;
	}

	/**
	 * Pushes a single note, used on the debounced local-edit path.
	 *
	 * Re-reads the remote revision immediately before writing: the whole
	 * point is to refuse rather than overwrite when Outline has moved on.
	 */
	async pushNote(file: TFile): Promise<"pushed" | "conflict" | "skipped"> {
		const record = this.state.byPath(file.path);
		if (!record) return "skipped";

		const content = await this.app.vault.read(file);
		const local: LocalNote = {
			file,
			path: file.path,
			body: parseNote(content).body,
			outlineId: record.documentId,
			hash: hashBody(parseNote(content).body),
		};
		if (local.hash === record.baseHash) return "skipped";

		const remote = await this.client.getDocument(record.documentId);
		if (!remote) return "skipped";

		if (this.remoteHasChanged(remote, record)) {
			const conflict = await this.buildConflict(record, local, remote);
			const summary = emptySummary();
			await this.applyResolutions([conflict], summary);
			await this.persist();
			return "conflict";
		}

		await this.push(record, local);
		await this.persist();
		return "pushed";
	}

	private async applyResolutions(conflicts: Conflict[], summary: SyncSummary): Promise<void> {
		const decisions = this.autoResolve(conflicts, this.settings.conflictPolicy);
		const unresolved = conflicts.filter((conflict) => !decisions.has(conflict.record.documentId));

		if (unresolved.length > 0) {
			const answers = await this.hooks.resolveConflicts(unresolved);
			for (const [documentId, resolution] of answers) decisions.set(documentId, resolution);
		}

		for (const conflict of conflicts) {
			const resolution = decisions.get(conflict.record.documentId) ?? "skip";
			try {
				await this.applyResolution(conflict, resolution);
				if (resolution !== "skip") summary.conflicts--;
			} catch (error) {
				summary.errors.push(describe(error, conflict.record.title));
			}
		}
	}

	private autoResolve(conflicts: Conflict[], policy: ConflictPolicy): Map<string, Resolution> {
		const decisions = new Map<string, Resolution>();
		if (policy === "ask") return decisions;

		for (const conflict of conflicts) {
			if (policy === "local" || policy === "remote") {
				decisions.set(conflict.record.documentId, policy);
				continue;
			}
			const localMtime = this.noteMtime(conflict.path);
			const remoteMtime = Date.parse(conflict.remote.updatedAt);
			decisions.set(conflict.record.documentId, localMtime > remoteMtime ? "local" : "remote");
		}
		return decisions;
	}

	private async applyResolution(conflict: Conflict, resolution: Resolution): Promise<void> {
		switch (resolution) {
			case "local": {
				const file = this.app.vault.getFileByPath(conflict.path);
				if (!file) return;
				const content = await this.app.vault.read(file);
				const local: LocalNote = {
					file,
					path: conflict.path,
					body: parseNote(content).body,
					outlineId: conflict.record.documentId,
					hash: hashBody(parseNote(content).body),
				};
				// Adopt the current remote revision as the base so the write is
				// accepted rather than rejected as stale a second time.
				await this.push({ ...conflict.record, baseRevision: conflict.remote.revision }, local);
				return;
			}
			case "remote":
				await this.pull(conflict.remote, conflict.path, conflict.record);
				return;
			case "both": {
				// Keep the local text where it is, park Outline's version beside it.
				const copyPath = this.uniquePath(withSuffix(conflict.path, ` (Outline ${stamp()})`));
				await this.writeNote(copyPath, conflict.remoteBody, {});
				const file = this.app.vault.getFileByPath(conflict.path);
				if (!file) return;
				const content = await this.app.vault.read(file);
				const local: LocalNote = {
					file,
					path: conflict.path,
					body: parseNote(content).body,
					outlineId: conflict.record.documentId,
					hash: hashBody(parseNote(content).body),
				};
				await this.push({ ...conflict.record, baseRevision: conflict.remote.revision }, local);
				return;
			}
			case "skip":
				return;
		}
	}

	private async buildConflict(record: SyncRecord, local: LocalNote, remote: RemoteDocument): Promise<Conflict> {
		return {
			record,
			path: local.path,
			localBody: local.body,
			remote,
			remoteBody: this.fromOutline(await this.materializeAttachments(remote, local.path)),
		};
	}

	private async pull(remote: RemoteDocument, path: string, record?: SyncRecord): Promise<void> {
		// Outline's markdown is re-serialised rich text; bring it back to Obsidian
		// style (restore soft breaks, dash bullets, unescape) before writing.
		const body = this.fromOutline(await this.materializeAttachments(remote, path));
		const existing = this.app.vault.getFileByPath(record?.path ?? path);

		if (existing && record && record.path !== path) {
			await this.app.fileManager.renameFile(existing, this.uniquePath(path));
		}

		await this.writeNote(path, body, {
			outlineId: remote.id,
			outlineUrl: `${this.client.origin}/doc/${remote.urlId}`,
		});
		this.recordAgreement(remote, path, hashBody(body));
	}

	private async push(record: SyncRecord, local: LocalNote): Promise<void> {
		const text = this.toOutline(await this.uploadNewImages(local));
		const title = titleFromPath(local.path);

		const updated = await this.client.updateDocument({
			id: record.documentId,
			text,
			...(title !== record.title ? { title } : {}),
		});

		// A jump of more than one revision means somebody wrote between our
		// check and our write. Their text is still in Outline's history.
		if (updated.revision > record.baseRevision + 1) {
			this.hooks.onError(
				`${title}: Outline moved from revision ${record.baseRevision} to ${updated.revision} during the push. ` +
					`Earlier text is recoverable from the document's history in Outline.`,
			);
		}
		// Baseline against Outline's re-serialised form, so this push does not read
		// as a remote change on the next poll and clobber the local formatting.
		const stored = (await this.client.getDocument(record.documentId)) ?? updated;
		this.recordAgreement(stored, local.path, local.hash);
	}

	/** Syncs non-markdown files as attachment-wrapped "file documents". */
	private async syncFiles(
		mappings: CollectionMapping[],
		remoteById: Map<string, RemoteDocument>,
		folderByCollection: Map<string, string>,
		summary: SyncSummary,
		doPull: boolean,
		doPush: boolean,
	): Promise<void> {
		const exts = new Set(
			this.settings.syncFileExtensions.map((e) => e.toLowerCase().replace(/^\./, "")).filter(Boolean),
		);
		if (exts.size === 0) return;

		// Remote file documents, keyed by the local path they map to. Overlapping
		// syncs used to create several documents for one file; collapse them and
		// delete the extras, preferring the one a record already tracks.
		const remoteFiles = new Map<string, RemoteDocument>();
		const duplicates: RemoteDocument[] = [];
		for (const remote of remoteById.values()) {
			const folder = folderByCollection.get(remote.collectionId);
			if (!folder) continue;
			const parsed = parseFileWrapper(remote.text);
			if (!parsed) continue;
			const path = this.fileWrapperPath(remote, remoteById, folder, parsed.name);
			const existing = remoteFiles.get(path);
			if (!existing) {
				remoteFiles.set(path, remote);
				continue;
			}
			if (remote.id === this.state.byPath(path)?.documentId) {
				duplicates.push(existing);
				remoteFiles.set(path, remote);
			} else {
				duplicates.push(remote);
			}
		}
		if (doPush) {
			for (const dup of duplicates) {
				try {
					await this.client.deleteDocument(dup.id);
					remoteById.delete(dup.id);
					this.state.remove(dup.id);
					summary.deleted++;
				} catch (error) {
					summary.errors.push(describe(error, dup.title));
				}
			}
		}

		const localFiles = await this.scanFiles(
			mappings.map((mapping) => mapping.folder),
			exts,
		);
		const seen = new Set<string>();

		for (const local of localFiles) {
			seen.add(local.path);
			const record = this.state.byPath(local.path);
			const remote = remoteFiles.get(local.path);
			try {
				if (!remote) {
					// New local file. (If its wrapper is gone from Outline, the
					// deletion sweep handles it — don't recreate here.)
					const wrapperDeleted = record?.isFile && !remoteById.has(record.documentId);
					if (doPush && !wrapperDeleted) {
						await this.createFile(local, mappings, remoteById, folderByCollection);
						summary.created++;
					}
					continue;
				}
				const localChanged = !record || local.hash !== record.baseHash;
				const remoteChanged = !record || hashBody(remote.text) !== record.baseRemoteHash;
				if (localChanged && doPush) {
					if (remoteChanged) {
						this.hooks.onError(
							`${parseFileWrapper(remote.text)?.name ?? local.path}: changed in both places; kept your local file.`,
						);
					}
					await this.pushFileWrapper(local, remote);
					summary.pushed++;
				} else if (remoteChanged && doPull) {
					await this.pullFile(remote, local.path);
					summary.pulled++;
				}
			} catch (error) {
				summary.errors.push(describe(error, local.path));
			}
		}

		// File documents this vault has never downloaded.
		if (doPull) {
			for (const [localPath, remote] of remoteFiles) {
				if (seen.has(localPath) || this.app.vault.getAbstractFileByPath(normalizePath(localPath))) continue;
				try {
					await this.pullFile(remote, localPath);
					summary.pulled++;
				} catch (error) {
					summary.errors.push(describe(error, remote.title));
				}
			}
		}
	}

	private fileWrapperPath(
		remote: RemoteDocument,
		remoteById: Map<string, RemoteDocument>,
		rootFolder: string,
		name: string,
	): string {
		const folder = parentFolderOf(pathForDocument(remote, remoteById, rootFolder));
		return folder ? `${folder}/${name}` : name;
	}

	private async scanFiles(
		folders: string[],
		exts: Set<string>,
	): Promise<{ file: TFile; path: string; hash: string }[]> {
		const out: { file: TFile; path: string; hash: string }[] = [];
		for (const file of this.app.vault.getFiles()) {
			const ext = (file.path.split(".").pop() ?? "").toLowerCase();
			if (!exts.has(ext)) continue;
			if (!folders.some((folder) => isInsideFolder(file.path, folder))) continue;
			const data = await this.app.vault.readBinary(file);
			out.push({ file, path: file.path, hash: hashBytes(data) });
		}
		return out;
	}

	private async uploadFileAttachment(file: TFile, name: string): Promise<string> {
		const data = await this.app.vault.readBinary(file);
		const contentType = contentTypeForPath(name);
		const upload = await this.client.createAttachment({ name, contentType, size: data.byteLength });
		await this.client.uploadAttachmentData(upload, data, name, contentType);
		return upload.attachment.id;
	}

	private async createFile(
		local: { file: TFile; path: string; hash: string },
		mappings: CollectionMapping[],
		remoteById: Map<string, RemoteDocument>,
		folderByCollection: Map<string, string>,
	): Promise<void> {
		const mapping = mappings.find((candidate) => isInsideFolder(local.path, candidate.folder));
		if (!mapping) return;
		const name = local.path.split("/").pop() ?? local.path;
		const attachmentId = await this.uploadFileAttachment(local.file, name);
		const parentDocumentId = await this.ensureFolderPlaceholder(
			parentFolderOf(local.path),
			mapping.collectionId,
			remoteById,
			folderByCollection,
		);
		const created = await this.client.createDocument({
			title: name,
			text: buildFileWrapper(name, attachmentId),
			collectionId: mapping.collectionId,
			parentDocumentId,
		});
		const stored = (await this.client.getDocument(created.id)) ?? created;
		remoteById.set(stored.id, stored);
		this.recordFileAgreement(stored, local.path, local.hash);
	}

	private async pushFileWrapper(
		local: { file: TFile; path: string; hash: string },
		remote: RemoteDocument,
	): Promise<void> {
		const name = local.path.split("/").pop() ?? local.path;
		const attachmentId = await this.uploadFileAttachment(local.file, name);
		const updated = await this.client.updateDocument({ id: remote.id, text: buildFileWrapper(name, attachmentId) });
		const stored = (await this.client.getDocument(remote.id)) ?? updated;
		this.recordFileAgreement(stored, local.path, local.hash);
	}

	private async pullFile(remote: RemoteDocument, localPath: string): Promise<void> {
		const parsed = parseFileWrapper(remote.text);
		if (!parsed) return;
		const { data } = await this.client.downloadAttachment(parsed.attachmentId);
		await this.ensureFolder(parentFolderOf(localPath));
		await this.writeBinary(localPath, data);
		this.recordFileAgreement(remote, localPath, hashBytes(data));
	}

	private async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const normalized = normalizePath(path);
		const existing = this.app.vault.getFileByPath(normalized);
		if (existing) await this.app.vault.modifyBinary(existing, data);
		else await this.app.vault.createBinary(normalized, data);
	}

	private recordFileAgreement(remote: RemoteDocument, path: string, bytesHash: string): void {
		this.state.set({
			documentId: remote.id,
			collectionId: remote.collectionId,
			path,
			title: remote.title,
			baseRevision: remote.revision,
			baseHash: bytesHash,
			baseRemoteHash: hashBody(remote.text),
			baseUpdatedAt: remote.updatedAt,
			parentDocumentId: remote.parentDocumentId,
			isFile: true,
		});
	}

	/** Propagates a local folder move to Outline by re-parenting the document. */
	private async moveRemote(
		record: SyncRecord,
		local: LocalNote,
		remoteById: Map<string, RemoteDocument>,
		folderByCollection: Map<string, string>,
	): Promise<void> {
		const parentId = await this.ensureFolderPlaceholder(
			parentFolderOf(local.path),
			record.collectionId,
			remoteById,
			folderByCollection,
		);
		await this.client.moveDocument({
			id: record.documentId,
			collectionId: record.collectionId,
			parentDocumentId: parentId,
		});
		// Re-baseline against Outline's stored form at the note's new location.
		const stored = (await this.client.getDocument(record.documentId)) ?? remoteById.get(record.documentId);
		if (stored) {
			remoteById.set(stored.id, stored);
			this.recordAgreement(stored, local.path, local.hash);
		}
	}

	private async create(
		note: LocalNote,
		collectionId: string,
		remoteById: Map<string, RemoteDocument>,
		folderByCollection: Map<string, string>,
	): Promise<void> {
		const parentDocumentId = await this.ensureFolderPlaceholder(
			parentFolderOf(note.path),
			collectionId,
			remoteById,
			folderByCollection,
		);
		const text = this.toOutline(await this.uploadNewImages(note));
		const created = await this.client.createDocument({
			title: titleFromPath(note.path),
			text,
			collectionId,
			parentDocumentId,
		});

		const content = await this.app.vault.read(note.file);
		await this.writeNote(note.path, parseNote(content).body, {
			outlineId: created.id,
			outlineUrl: `${this.client.origin}/doc/${created.urlId}`,
		});
		// Baseline against Outline's stored form (re-serialised from what we sent).
		const stored = (await this.client.getDocument(created.id)) ?? created;
		remoteById.set(created.id, stored);
		this.recordAgreement(stored, note.path, note.hash);
	}

	private async handleRemoteDeletion(record: SyncRecord): Promise<void> {
		const file = this.app.vault.getFileByPath(record.path);
		if (file && this.settings.propagateRemoteDeletes) {
			await this.app.fileManager.trashFile(file);
		} else if (file) {
			this.hooks.onError(`${record.title} was removed from Outline; the local note was kept.`);
		}
		this.state.remove(record.documentId);
	}

	/** Downloads any Outline-hosted images and points the markdown at them. */
	private async materializeAttachments(remote: RemoteDocument, notePath: string): Promise<string> {
		const references = findOutlineAttachments(remote.text);
		if (references.length === 0) return remote.text;

		const folder = normalizePath(this.settings.attachmentFolder.replace(/^\/+|\/+$/g, ""));
		if (folder) await this.ensureFolder(folder);

		const resolved = new Map<string, string>();
		for (const reference of references) {
			try {
				const existing = this.findAttachmentFile(folder, reference.attachmentId);
				if (existing) {
					resolved.set(reference.attachmentId, existing);
					continue;
				}
				const { data, contentType } = await this.client.downloadAttachment(reference.attachmentId);
				const path = `${folder ? `${folder}/` : ""}${reference.attachmentId}.${extensionForContentType(contentType)}`;
				await this.app.vault.createBinary(normalizePath(path), data);
				resolved.set(reference.attachmentId, path);
			} catch (error) {
				this.hooks.onError(`Could not download an image in ${remote.title}: ${describe(error, "")}`);
			}
		}

		void notePath; // links are vault-absolute, which Obsidian resolves from any note
		return rewriteAttachmentsToLocal(remote.text, (id) => resolved.get(id));
	}

	/** Uploads images that live only in the vault, returning Outline-ready text. */
	private async uploadNewImages(note: LocalNote): Promise<string> {
		let text = note.body;
		for (const image of findLocalImages(note.body)) {
			if (image.attachmentId) {
				text = rewriteImageToOutline(text, image, image.attachmentId);
				continue;
			}
			const file = this.resolveImageFile(image.target, note.path);
			if (!file) continue;
			try {
				const data = await this.app.vault.readBinary(file);
				const contentType = contentTypeForPath(file.path);
				const upload = await this.client.createAttachment({
					name: file.name,
					contentType,
					size: data.byteLength,
					documentId: note.outlineId,
				});
				await this.client.uploadAttachmentData(upload, data, file.name, contentType);
				text = rewriteImageToOutline(text, image, upload.attachment.id);
			} catch (error) {
				this.hooks.onError(`Could not upload ${image.target}: ${describe(error, "")}`);
			}
		}
		return text;
	}

	private resolveImageFile(target: string, sourcePath: string): TFile | null {
		const direct = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
		if (direct) return direct;
		const candidate = this.app.vault.getAbstractFileByPath(normalizePath(target));
		return candidate instanceof TFile ? candidate : null;
	}

	private findAttachmentFile(folder: string, attachmentId: string): string | undefined {
		for (const file of this.app.vault.getFiles()) {
			if (file.parent?.path === (folder || "/") && file.basename === attachmentId) return file.path;
		}
		return undefined;
	}

	/** The document whose child folder contains this path, if any. */
	/**
	 * Returns the Outline document id that a note or subfolder should nest under,
	 * creating folder placeholder documents up the chain as needed. Returns
	 * undefined at the mapped root — those documents live at the collection root.
	 */
	private async ensureFolderPlaceholder(
		folderPath: string,
		collectionId: string,
		remoteById: Map<string, RemoteDocument>,
		folderByCollection: Map<string, string>,
	): Promise<string | undefined> {
		if (!folderPath) return undefined;
		const root = (folderByCollection.get(collectionId) ?? "").replace(/^\/+|\/+$/g, "");
		if (folderPath === root) return undefined;

		// A hand-made `Folder.md` note wins: nest under it instead of a placeholder.
		const noteRecord = this.state.byPath(`${folderPath}.md`);
		if (noteRecord && remoteById.has(noteRecord.documentId)) return noteRecord.documentId;

		// Reuse a placeholder we already made for this folder.
		const existing = this.state.byPath(folderPath);
		if (existing?.isFolder && remoteById.has(existing.documentId)) return existing.documentId;

		// Create it — parents first, so nesting is correct at any depth.
		const parentId = await this.ensureFolderPlaceholder(
			parentFolderOf(folderPath),
			collectionId,
			remoteById,
			folderByCollection,
		);
		const title = folderPath.split("/").pop() ?? folderPath;
		const created = await this.client.createDocument({
			title,
			text: FOLDER_PLACEHOLDER_BODY,
			collectionId,
			parentDocumentId: parentId,
		});
		remoteById.set(created.id, created);
		this.state.set({
			documentId: created.id,
			collectionId,
			path: folderPath,
			title,
			baseRevision: created.revision,
			baseHash: hashBody(FOLDER_PLACEHOLDER_BODY),
			baseUpdatedAt: created.updatedAt,
			parentDocumentId: parentId,
			isFolder: true,
		});
		return created.id;
	}

	/** Mirrors an inert folder placeholder as a bare local folder. */
	private async adoptRemoteFolder(remote: RemoteDocument, desiredPath: string): Promise<void> {
		const folderPath = childFolderFor(desiredPath);
		await this.ensureFolder(folderPath);
		this.state.set({
			documentId: remote.id,
			collectionId: remote.collectionId,
			path: folderPath,
			title: remote.title,
			baseRevision: remote.revision,
			baseHash: hashBody(remote.text),
			baseUpdatedAt: remote.updatedAt,
			parentDocumentId: remote.parentDocumentId,
			isFolder: true,
		});
	}

	private async relocateNote(note: LocalNote, desiredPath: string, record: SyncRecord): Promise<void> {
		if (note.path === desiredPath) return;
		const target = this.uniquePath(desiredPath);
		await this.ensureFolder(target.slice(0, target.lastIndexOf("/")));
		await this.app.fileManager.renameFile(note.file, target);
		record.path = target;
	}

	private async scanVault(folders: string[]): Promise<LocalNote[]> {
		const notes: LocalNote[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!folders.some((folder) => isInsideFolder(file.path, folder))) continue;
			const content = await this.app.vault.read(file);
			const parsed = parseNote(content);
			const outlineId = typeof parsed.frontmatter.outlineId === "string" ? parsed.frontmatter.outlineId : undefined;
			notes.push({
				file,
				path: file.path,
				body: parsed.body,
				outlineId,
				hash: hashBody(parsed.body),
			});
		}
		return notes;
	}

	private noteAt(notes: LocalNote[], path: string): LocalNote | undefined {
		return notes.find((note) => note.path === path);
	}

	private noteMtime(path: string): number {
		return this.app.vault.getFileByPath(path)?.stat.mtime ?? 0;
	}

	private toLocalBody(remote: RemoteDocument, path: string): string {
		void path;
		return remote.text;
	}

	private provisionalRecord(remote: RemoteDocument, path: string): SyncRecord {
		return {
			documentId: remote.id,
			collectionId: remote.collectionId,
			path,
			title: remote.title,
			// No agreed base: revision -1 can never equal a real revision, so
			// this always reads as "remote changed".
			baseRevision: -1,
			baseHash: "",
			baseUpdatedAt: remote.updatedAt,
			parentDocumentId: remote.parentDocumentId,
		};
	}

	/**
	 * Whether Outline's copy has moved since our last agreement. Outline's
	 * collaborative editor updates `text` and `updatedAt` immediately but
	 * snapshots the `revision` counter only periodically, so revision alone
	 * misses edits made by typing in the browser — `updatedAt` catches them.
	 */
	/** Obsidian → Outline markdown, when conversion is enabled. */
	private toOutline(text: string): string {
		return this.settings.convertMarkdown ? encodeForOutline(text) : text;
	}

	/** Outline → Obsidian markdown, when conversion is enabled. */
	private fromOutline(text: string): string {
		return this.settings.convertMarkdown ? decodeFromOutline(text) : text;
	}

	private remoteHasChanged(remote: RemoteDocument, record: SyncRecord): boolean {
		// Preferred: compare Outline's stored text against the form it had at our
		// last agreement. This ignores Outline re-serialising our own push, and
		// catches editor edits that never advance the revision counter.
		if (record.baseRemoteHash !== undefined) {
			return hashBody(remote.text) !== record.baseRemoteHash;
		}
		// Records written before 0.4.0 have no remote-hash baseline yet.
		return remote.revision !== record.baseRevision || remote.updatedAt !== record.baseUpdatedAt;
	}

	/**
	 * Records agreement. `remote` must carry Outline's *stored* text (re-fetched
	 * after a push, since Outline re-serialises what we send) so the remote-hash
	 * baseline matches what a later poll will return.
	 */
	private recordAgreement(remote: RemoteDocument, path: string, localHash: string): void {
		this.state.set({
			documentId: remote.id,
			collectionId: remote.collectionId,
			path,
			title: remote.title,
			baseRevision: remote.revision,
			baseHash: localHash,
			baseRemoteHash: hashBody(remote.text),
			baseUpdatedAt: remote.updatedAt,
			parentDocumentId: remote.parentDocumentId,
		});
	}

	/** Writes a note and remembers the content so we ignore our own event. */
	private async writeNote(path: string, body: string, frontmatter: Record<string, unknown>): Promise<TFile> {
		const normalized = normalizePath(path);
		await this.ensureFolder(normalized.slice(0, normalized.lastIndexOf("/")));

		const existing = this.app.vault.getFileByPath(normalized);
		const previous = existing ? await this.app.vault.read(existing) : "";
		const content = withFrontmatter(previous ? replaceBody(previous, body) : body, frontmatter);

		this.selfWrites.set(normalized, hashBody(parseNote(content).body));
		if (existing) {
			await this.app.vault.modify(existing, content);
			return existing;
		}
		return this.app.vault.create(normalized, content);
	}

	private async ensureFolder(folder: string): Promise<void> {
		if (!folder) return;
		const normalized = normalizePath(folder);
		if (this.app.vault.getAbstractFileByPath(normalized)) return;
		const segments = normalized.split("/");
		let current = "";
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current).catch(() => undefined);
			}
		}
	}

	private uniquePath(path: string): string {
		if (!this.app.vault.getAbstractFileByPath(normalizePath(path))) return path;
		for (let counter = 2; counter < 100; counter++) {
			const candidate = withSuffix(path, ` ${counter}`);
			if (!this.app.vault.getAbstractFileByPath(normalizePath(candidate))) return candidate;
		}
		return withSuffix(path, ` ${Date.now()}`);
	}
}

/** Swaps a note's body while keeping whatever frontmatter it already had. */
function replaceBody(existingContent: string, body: string): string {
	const parsed = parseNote(existingContent);
	return parsed.rawFrontmatter + body;
}

function stamp(): string {
	return new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
}

function describe(error: unknown, subject: string): string {
	const detail = error instanceof OutlineApiError ? error.message : String(error);
	return subject ? `${subject}: ${detail}` : detail;
}

function emptySummary(): SyncSummary {
	return { pulled: 0, pushed: 0, created: 0, conflicts: 0, deleted: 0, errors: [] };
}

function mergeSummaries(first: SyncSummary, second: SyncSummary): SyncSummary {
	return {
		pulled: first.pulled + second.pulled,
		pushed: first.pushed + second.pushed,
		created: first.created + second.created,
		conflicts: first.conflicts + second.conflicts,
		deleted: first.deleted + second.deleted,
		errors: [...first.errors, ...second.errors],
	};
}

export { safeFileName };
