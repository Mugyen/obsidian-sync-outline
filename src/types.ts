/** Mapping between one Outline collection and one vault folder. */
export interface CollectionMapping {
	collectionId: string;
	/** Human-readable name, cached so settings render without a network call. */
	collectionName: string;
	/** Vault-relative folder, e.g. "Engineering". */
	folder: string;
}

export type ConflictPolicy = "ask" | "local" | "remote" | "newer";

export interface OutlineSyncSettings {
	/** Base URL of the Outline install, without /api. */
	baseUrl: string;
	apiToken: string;
	mappings: CollectionMapping[];
	/** Seconds between remote polls. 0 disables polling. */
	pollIntervalSeconds: number;
	/** Milliseconds to wait after the last local edit before pushing. */
	pushDebounceMs: number;
	syncOnStartup: boolean;
	conflictPolicy: ConflictPolicy;
	/** Folder for downloaded images, vault-relative. */
	attachmentFolder: string;
	/** Create documents in Outline for local files that have no outlineId. */
	createRemoteForNewFiles: boolean;
	/** Delete the remote document when its local file is deleted. Off by default. */
	propagateLocalDeletes: boolean;
	/** Move the local file to trash when the remote document disappears. */
	propagateRemoteDeletes: boolean;
	/**
	 * Convert markdown between Obsidian and Outline dialects on sync: preserve
	 * soft line breaks (via an invisible marker in Outline), restore dash bullets
	 * and unescape on pull. On by default. Turn off to exchange raw markdown and
	 * keep Outline documents free of the marker.
	 */
	convertMarkdown: boolean;
	/**
	 * Non-markdown file extensions (lowercase, no dot) to sync as attachments,
	 * e.g. ["html", "pdf"]. Each becomes a downloadable "file document" in Outline.
	 * Empty disables non-markdown sync.
	 */
	syncFileExtensions: string[];
	/** Version of the stored settings, for one-time migrations when defaults change. */
	settingsVersion: number;
}

export const DEFAULT_SETTINGS: OutlineSyncSettings = {
	baseUrl: "",
	apiToken: "",
	mappings: [],
	pollIntervalSeconds: 60,
	pushDebounceMs: 60_000,
	syncOnStartup: true,
	conflictPolicy: "ask",
	attachmentFolder: "Outline Attachments",
	createRemoteForNewFiles: true,
	propagateLocalDeletes: false,
	propagateRemoteDeletes: true,
	convertMarkdown: true,
	syncFileExtensions: ["html"],
	settingsVersion: 1,
};

/**
 * What we knew about a document the last time local and remote agreed.
 * This is the merge base: without it we cannot tell "they changed it"
 * from "I changed it".
 */
export interface SyncRecord {
	documentId: string;
	collectionId: string;
	/** Vault-relative path of the note. */
	path: string;
	title: string;
	/** Outline's monotonic revision counter at last agreement. */
	baseRevision: number;
	/** Hash of the local body (frontmatter excluded) at last agreement. */
	baseHash: string;
	/**
	 * Hash of Outline's own stored text at last agreement. Because Outline
	 * re-serialises markdown, this — not baseHash — is what a later poll's remote
	 * text is compared against, so our own edits bouncing back are not mistaken
	 * for a remote change. Absent on records written before 0.4.0.
	 */
	baseRemoteHash?: string;
	/** Remote updatedAt at last agreement, for display only. */
	baseUpdatedAt: string;
	parentDocumentId?: string;
	/** A folder placeholder: represents an Obsidian folder, has no local note. */
	isFolder?: boolean;
	/** A file document: wraps a non-markdown file as an Outline attachment. */
	isFile?: boolean;
}

export interface SyncState {
	version: 1;
	records: Record<string, SyncRecord>;
	lastSyncAt?: string;
}

export interface RemoteDocument {
	id: string;
	urlId: string;
	title: string;
	text: string;
	revision: number;
	updatedAt: string;
	collectionId: string;
	parentDocumentId?: string;
	updatedBy?: { id: string; name: string };
}

export interface OutlineCollection {
	id: string;
	urlId: string;
	name: string;
}

export interface AttachmentUpload {
	uploadUrl: string;
	form: Record<string, string>;
	attachment: { id: string; url: string; name: string; contentType: string; size: number };
}

/** One unit of work produced by the reconciler. */
export type SyncAction =
	| { kind: "pull"; remote: RemoteDocument; path: string; record?: SyncRecord }
	| { kind: "push"; record: SyncRecord; path: string; body: string; title: string }
	| { kind: "create"; path: string; body: string; title: string; collectionId: string }
	| { kind: "conflict"; record: SyncRecord; path: string; localBody: string; remote: RemoteDocument }
	| { kind: "remote-deleted"; record: SyncRecord }
	| { kind: "local-deleted"; record: SyncRecord };

export interface SyncSummary {
	pulled: number;
	pushed: number;
	created: number;
	conflicts: number;
	deleted: number;
	errors: string[];
}
