import type { SyncRecord, SyncState } from "../types";
import { renamedPath } from "./paths";

export function emptyState(): SyncState {
	return { version: 1, records: {} };
}

/**
 * The sync index: what local and remote last agreed on, per document.
 *
 * Held apart from the notes themselves so that recording a sync never
 * rewrites a file — a write would fire the vault's modify event and the
 * plugin would chase its own tail.
 */
export class SyncStateStore {
	private state: SyncState;

	constructor(state?: SyncState) {
		this.state = state && state.version === 1 ? state : emptyState();
	}

	toJSON(): SyncState {
		return this.state;
	}

	get lastSyncAt(): string | undefined {
		return this.state.lastSyncAt;
	}

	markSynced(): void {
		this.state.lastSyncAt = new Date().toISOString();
	}

	get(documentId: string): SyncRecord | undefined {
		return this.state.records[documentId];
	}

	byPath(path: string): SyncRecord | undefined {
		return Object.values(this.state.records).find((record) => record.path === path);
	}

	all(): SyncRecord[] {
		return Object.values(this.state.records);
	}

	set(record: SyncRecord): void {
		this.state.records[record.documentId] = record;
	}

	remove(documentId: string): void {
		delete this.state.records[documentId];
	}

	/** Follows a note that was renamed or moved inside the vault. */
	relocate(oldPath: string, newPath: string): SyncRecord | undefined {
		const record = this.byPath(oldPath);
		if (!record) return undefined;
		record.path = newPath;
		return record;
	}

	/** Follows a renamed or moved folder: every record inside it gets the new path. */
	relocateFolder(from: string, to: string): number {
		let moved = 0;
		for (const record of Object.values(this.state.records)) {
			const next = renamedPath(record.path, from, to);
			if (next !== undefined && next !== record.path) {
				record.path = next;
				moved++;
			}
		}
		return moved;
	}

	/** Drops every record belonging to one collection (when it stops being synced). */
	forgetCollection(collectionId: string): void {
		for (const [id, record] of Object.entries(this.state.records)) {
			if (record.collectionId === collectionId) delete this.state.records[id];
		}
	}

	/** Drops records whose documents are no longer in a synced collection. */
	pruneToCollections(collectionIds: Set<string>): void {
		for (const [id, record] of Object.entries(this.state.records)) {
			if (!collectionIds.has(record.collectionId)) delete this.state.records[id];
		}
	}
}
