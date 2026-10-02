/* Scenario tests for the reconciler. Run: npm test */
import assert from "node:assert/strict";

import type { OutlineClient } from "../src/outline/client";
import { SyncEngine, type Conflict, type Resolution } from "../src/sync/engine";
import { buildFileWrapper, hashBody, parseNote, withFrontmatter } from "../src/sync/markdown";
import { FOLDER_MARKER, FOLDER_PLACEHOLDER_BODY } from "../src/sync/paths";
import { SyncStateStore } from "../src/sync/state";
import { DEFAULT_SETTINGS, type OutlineSyncSettings, type RemoteDocument } from "../src/types";
import { FakeApp } from "./fake-vault";

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
	} catch (error) {
		failures.push(`FAIL  ${name}\n      ${String(error)}`);
		process.exitCode = 1;
	}
}

class FakeClient {
	readonly updates: { id: string; text?: string; title?: string }[] = [];
	readonly creates: { title: string; text: string; parentDocumentId?: string }[] = [];
	readonly deletes: string[] = [];
	private nextRevision = new Map<string, number>();

	constructor(private documents: RemoteDocument[]) {}

	get origin(): string {
		return "https://outline.test";
	}
	private readonly hiddenFromList = new Set<string>();
	async listDocuments(collectionId: string): Promise<RemoteDocument[]> {
		return this.documents.filter(
			(document) => document.collectionId === collectionId && !this.hiddenFromList.has(document.id),
		);
	}
	async getDocument(id: string): Promise<RemoteDocument | undefined> {
		return this.documents.find((document) => document.id === id);
	}
	/** Simulates a document Outline still has but omits from documents.list. */
	hideFromList(id: string): void {
		this.hiddenFromList.add(id);
	}
	/** Mimics Outline's markdown serialisation: merges soft-break lines and pads link text. */
	private storeText(text: string): string {
		return text
			.replace(new RegExp("⁠\\n", "g"), "⁠ ")
			.replace(/\[([^\]]+)\]\(\/api\/attachments/g, "[ $1](/api/attachments");
	}
	async updateDocument(params: { id: string; text?: string; title?: string }): Promise<RemoteDocument> {
		this.updates.push(params);
		const document = this.documents.find((candidate) => candidate.id === params.id);
		if (!document) throw new Error(`no such document ${params.id}`);
		const bumped = this.nextRevision.get(params.id) ?? document.revision + 1;
		document.revision = bumped;
		if (params.text !== undefined) document.text = this.storeText(params.text);
		if (params.title !== undefined) document.title = params.title;
		document.updatedAt = new Date().toISOString();
		return { ...document };
	}
	/** Forces the next update of this document to report a jumped revision. */
	simulateRaceOn(id: string, revision: number): void {
		this.nextRevision.set(id, revision);
	}
	async createDocument(params: {
		title: string;
		text: string;
		collectionId: string;
		parentDocumentId?: string;
	}): Promise<RemoteDocument> {
		this.creates.push({ title: params.title, text: params.text, parentDocumentId: params.parentDocumentId });
		const created: RemoteDocument = {
			id: `new-${this.creates.length}`,
			urlId: `new-${this.creates.length}`,
			title: params.title,
			text: this.storeText(params.text),
			revision: 1,
			updatedAt: new Date().toISOString(),
			collectionId: params.collectionId,
			parentDocumentId: params.parentDocumentId,
		};
		this.documents.push(created);
		return created;
	}
	async deleteDocument(id: string): Promise<void> {
		this.deletes.push(id);
	}
	readonly moves: { id: string; parentDocumentId?: string }[] = [];
	async moveDocument(params: { id: string; collectionId: string; parentDocumentId?: string }): Promise<void> {
		this.moves.push({ id: params.id, parentDocumentId: params.parentDocumentId });
		const document = this.documents.find((candidate) => candidate.id === params.id);
		if (document) document.parentDocumentId = params.parentDocumentId;
	}

	// ---- attachments (for non-markdown file sync) ----
	readonly attachments = new Map<string, ArrayBuffer>();
	private attachmentSeq = 0;
	async createAttachment(params: { name: string; contentType: string; size: number }): Promise<{
		uploadUrl: string;
		form: Record<string, string>;
		attachment: { id: string; url: string; name: string; contentType: string; size: number };
	}> {
		const id = `00000000-0000-0000-0000-${String(++this.attachmentSeq).padStart(12, "0")}`;
		return {
			uploadUrl: "/api/files.create",
			form: {},
			attachment: {
				id,
				url: `/api/attachments.redirect?id=${id}`,
				name: params.name,
				contentType: params.contentType,
				size: params.size,
			},
		};
	}
	async uploadAttachmentData(
		upload: { attachment: { id: string } },
		data: ArrayBuffer,
	): Promise<void> {
		this.attachments.set(upload.attachment.id, data);
	}
	async downloadAttachment(id: string): Promise<{ data: ArrayBuffer; contentType: string }> {
		return { data: this.attachments.get(id) ?? new ArrayBuffer(0), contentType: "application/octet-stream" };
	}
	/** Simulates somebody editing in the browser. */
	editInOutline(id: string, text: string): void {
		const document = this.documents.find((candidate) => candidate.id === id);
		if (!document) throw new Error(`no such document ${id}`);
		document.text = text;
		document.revision += 1;
		document.updatedAt = new Date().toISOString();
	}
	/**
	 * Outline's collaborative editor updates text + updatedAt immediately but
	 * only snapshots the `revision` counter periodically. This reproduces an
	 * edit that has not yet advanced the revision.
	 */
	editInOutlineWithoutRevisionBump(id: string, text: string): void {
		const document = this.documents.find((candidate) => candidate.id === id);
		if (!document) throw new Error(`no such document ${id}`);
		document.text = text;
		document.updatedAt = new Date(Date.parse(document.updatedAt) + 60_000).toISOString();
	}
	removeFromOutline(id: string): void {
		this.documents = this.documents.filter((document) => document.id !== id);
	}
}

interface Harness {
	app: FakeApp;
	client: FakeClient;
	state: SyncStateStore;
	engine: SyncEngine;
	conflictsSeen: Conflict[];
	answer: Resolution;
}

function harness(documents: RemoteDocument[], overrides: Partial<OutlineSyncSettings> = {}): Harness {
	const app = new FakeApp();
	const client = new FakeClient(documents);
	const state = new SyncStateStore();
	const settings: OutlineSyncSettings = {
		...DEFAULT_SETTINGS,
		baseUrl: "https://outline.test",
		apiToken: "token",
		mappings: [{ collectionId: "col", collectionName: "Wiki", folder: "Wiki" }],
		...overrides,
	};

	const result: Harness = {
		app,
		client,
		state,
		conflictsSeen: [],
		answer: "skip",
		engine: undefined as unknown as SyncEngine,
	};

	result.engine = new SyncEngine(
		app as never,
		client as unknown as OutlineClient,
		state,
		settings,
		{
			resolveConflicts: async (conflicts) => {
				result.conflictsSeen.push(...conflicts);
				return new Map(conflicts.map((conflict) => [conflict.record.documentId, result.answer]));
			},
			onStatus: () => undefined,
			onError: () => undefined,
		},
		async () => undefined,
	);
	return result;
}

function remoteDoc(id: string, title: string, text: string, revision = 1): RemoteDocument {
	return {
		id,
		urlId: id,
		title,
		text,
		revision,
		updatedAt: new Date(Date.now() - 60_000).toISOString(),
		collectionId: "col",
	};
}

function bodyOf(app: FakeApp, path: string): string {
	return parseNote(app.vault.files.get(path) ?? "").body;
}

await test("first sync downloads a document into the mapped folder", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation details")]);
	const summary = await h.engine.syncAll();

	assert.equal(summary.pulled, 1);
	assert.equal(bodyOf(h.app, "Wiki/Oncall.md"), "Rotation details");
	assert.equal(parseNote(h.app.vault.files.get("Wiki/Oncall.md") ?? "").frontmatter.outlineId, "d1");
});

await test("a second sync with nothing changed does nothing", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation details")]);
	await h.engine.syncAll();
	const summary = await h.engine.syncAll();

	assert.deepEqual(
		{ pulled: summary.pulled, pushed: summary.pushed, conflicts: summary.conflicts },
		{ pulled: 0, pushed: 0, conflicts: 0 },
	);
	assert.equal(h.client.updates.length, 0);
});

await test("a local-only edit is pushed", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation details")]);
	await h.engine.syncAll();

	const path = "Wiki/Oncall.md";
	h.app.vault.seed(path, withFrontmatter("Rotation details\n\nPrimary: Saksham", { outlineId: "d1" }));
	const summary = await h.engine.syncAll();

	assert.equal(summary.pushed, 1);
	assert.equal(h.client.updates.length, 1);
	assert.ok(h.client.updates[0].text?.includes("Primary: Saksham"));
});

await test("a remote-only edit is pulled", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation details")]);
	await h.engine.syncAll();

	h.client.editInOutline("d1", "Rotation details\n\nPrimary: Rahul");
	const summary = await h.engine.syncAll();

	assert.equal(summary.pulled, 1);
	assert.ok(bodyOf(h.app, "Wiki/Oncall.md").includes("Primary: Rahul"));
	assert.equal(h.client.updates.length, 0);
});

await test("edits on both sides raise a conflict instead of overwriting", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();

	h.app.vault.seed("Wiki/Oncall.md", withFrontmatter("Rotation\n\nPrimary: Saksham", { outlineId: "d1" }));
	h.client.editInOutline("d1", "Rotation\n\nPrimary: Rahul");

	h.answer = "skip";
	await h.engine.syncAll();

	assert.equal(h.conflictsSeen.length, 1);
	assert.ok(h.conflictsSeen[0].localBody.includes("Saksham"));
	assert.ok(h.conflictsSeen[0].remoteBody.includes("Rahul"));
	// Skipping must leave both sides exactly as they were.
	assert.ok(bodyOf(h.app, "Wiki/Oncall.md").includes("Saksham"));
	assert.equal(h.client.updates.length, 0);
});

await test("an unresolved conflict is raised again on the next sync", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();
	h.app.vault.seed("Wiki/Oncall.md", withFrontmatter("Rotation\n\nMine", { outlineId: "d1" }));
	h.client.editInOutline("d1", "Rotation\n\nTheirs");

	await h.engine.syncAll();
	await h.engine.syncAll();

	assert.equal(h.conflictsSeen.length, 2);
});

await test("keeping local overwrites Outline", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();
	h.app.vault.seed("Wiki/Oncall.md", withFrontmatter("Rotation\n\nMine", { outlineId: "d1" }));
	h.client.editInOutline("d1", "Rotation\n\nTheirs");

	h.answer = "local";
	await h.engine.syncAll();

	assert.equal(h.client.updates.length, 1);
	assert.ok(h.client.updates[0].text?.includes("Mine"));
	assert.ok(bodyOf(h.app, "Wiki/Oncall.md").includes("Mine"));
});

await test("keeping Outline overwrites the local note", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();
	h.app.vault.seed("Wiki/Oncall.md", withFrontmatter("Rotation\n\nMine", { outlineId: "d1" }));
	h.client.editInOutline("d1", "Rotation\n\nTheirs");

	h.answer = "remote";
	await h.engine.syncAll();

	assert.ok(bodyOf(h.app, "Wiki/Oncall.md").includes("Theirs"));
	assert.equal(h.client.updates.length, 0);
});

await test("keeping both parks Outline's version in a second note", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();
	h.app.vault.seed("Wiki/Oncall.md", withFrontmatter("Rotation\n\nMine", { outlineId: "d1" }));
	h.client.editInOutline("d1", "Rotation\n\nTheirs");

	h.answer = "both";
	await h.engine.syncAll();

	const copies = [...h.app.vault.files.keys()].filter((path) => path.includes("(Outline"));
	assert.equal(copies.length, 1);
	assert.ok(h.app.vault.files.get(copies[0])?.includes("Theirs"));
	assert.ok(bodyOf(h.app, "Wiki/Oncall.md").includes("Mine"));
	assert.ok(h.client.updates[0].text?.includes("Mine"));
});

await test("after resolving, the next sync is quiet", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();
	h.app.vault.seed("Wiki/Oncall.md", withFrontmatter("Rotation\n\nMine", { outlineId: "d1" }));
	h.client.editInOutline("d1", "Rotation\n\nTheirs");

	h.answer = "local";
	await h.engine.syncAll();
	h.conflictsSeen.length = 0;
	const summary = await h.engine.syncAll();

	assert.equal(h.conflictsSeen.length, 0);
	assert.equal(summary.pushed, 0);
	assert.equal(summary.pulled, 0);
});

await test("the newer-wins policy resolves without asking", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")], { conflictPolicy: "newer" });
	await h.engine.syncAll();
	h.app.vault.seed(
		"Wiki/Oncall.md",
		withFrontmatter("Rotation\n\nMine", { outlineId: "d1" }),
		Date.now() + 60_000,
	);
	h.client.editInOutline("d1", "Rotation\n\nTheirs");

	await h.engine.syncAll();

	assert.equal(h.conflictsSeen.length, 0, "should not have asked");
	assert.ok(h.client.updates[0]?.text?.includes("Mine"), "the newer local note should win");
});

await test("a new local note becomes an Outline document", async () => {
	const h = harness([]);
	h.app.vault.seed("Wiki/Design Notes.md", "First draft");
	const summary = await h.engine.syncAll();

	assert.equal(summary.created, 1);
	assert.equal(h.client.creates[0].title, "Design Notes");
	assert.equal(
		parseNote(h.app.vault.files.get("Wiki/Design Notes.md") ?? "").frontmatter.outlineId,
		"new-1",
	);
});

await test("notes outside a mapped folder are left alone", async () => {
	const h = harness([]);
	h.app.vault.seed("Personal/Journal.md", "Private");
	const summary = await h.engine.syncAll();

	assert.equal(summary.created, 0);
	assert.equal(h.client.creates.length, 0);
});

await test("a renamed note retitles the document", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();

	const content = h.app.vault.files.get("Wiki/Oncall.md") ?? "";
	h.app.vault.files.delete("Wiki/Oncall.md");
	h.app.vault.seed("Wiki/Oncall Rotation.md", `${content}\nedited`);
	h.state.relocate("Wiki/Oncall.md", "Wiki/Oncall Rotation.md");

	await h.engine.syncAll();
	assert.equal(h.client.updates[0]?.title, "Oncall Rotation");
});

await test("a document deleted in Outline sends the note to trash", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();

	h.client.removeFromOutline("d1");
	const summary = await h.engine.syncAll();

	assert.equal(summary.deleted, 1);
	assert.deepEqual(h.app.vault.trashed, ["Wiki/Oncall.md"]);
});

await test("a note deleted locally is restored rather than deleted for everyone", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();

	h.app.vault.files.delete("Wiki/Oncall.md");
	await h.engine.syncAll();

	assert.ok(h.app.vault.files.has("Wiki/Oncall.md"), "the note should come back");
	assert.equal(h.client.deletes.length, 0, "nothing should be deleted in Outline");
});

await test("a note carrying an unknown outlineId is adopted when the text matches", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	h.app.vault.seed("Wiki/Oncall.md", withFrontmatter("Rotation", { outlineId: "d1" }));

	const summary = await h.engine.syncAll();

	assert.equal(summary.conflicts, 0);
	assert.equal(h.client.updates.length, 0);
	assert.equal(h.state.get("d1")?.baseRevision, 1);
});

await test("a note carrying an unknown outlineId conflicts when the text differs", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	h.app.vault.seed("Wiki/Oncall.md", withFrontmatter("Something else entirely", { outlineId: "d1" }));

	h.answer = "skip";
	await h.engine.syncAll();

	assert.equal(h.conflictsSeen.length, 1);
});

await test("child documents nest under a folder named for the parent", async () => {
	const parent = remoteDoc("p1", "Handbook", "Index");
	const child = remoteDoc("c1", "Oncall", "Rotation");
	child.parentDocumentId = "p1";
	const h = harness([parent, child]);

	await h.engine.syncAll();

	assert.ok(h.app.vault.files.has("Wiki/Handbook.md"));
	assert.ok(h.app.vault.files.has("Wiki/Handbook/Oncall.md"));
});

await test("a title change in Outline moves the local note", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();

	const document = (await h.client.getDocument("d1")) as RemoteDocument;
	document.title = "Oncall Rotation";
	document.revision += 1;
	await h.engine.syncAll();

	assert.ok(h.app.vault.files.has("Wiki/Oncall Rotation.md"));
	assert.ok(!h.app.vault.files.has("Wiki/Oncall.md"));
});

await test("pushNote refuses a stale write and raises a conflict", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();

	h.app.vault.seed("Wiki/Oncall.md", withFrontmatter("Rotation\n\nMine", { outlineId: "d1" }));
	h.client.editInOutline("d1", "Rotation\n\nTheirs");

	h.answer = "skip";
	const file = h.app.vault.getFileByPath("Wiki/Oncall.md");
	const outcome = await h.engine.pushNote(file as never);

	assert.equal(outcome, "conflict");
	assert.equal(h.client.updates.length, 0);
	assert.equal(h.conflictsSeen.length, 1);
});

await test("a write that lands on a jumped revision is reported, not swallowed", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	const errors: string[] = [];
	await h.engine.syncAll();

	// Rebuild the engine so we can capture onError for this scenario.
	const engine = new SyncEngine(
		h.app as never,
		h.client as unknown as OutlineClient,
		h.state,
		{
			...DEFAULT_SETTINGS,
			baseUrl: "https://outline.test",
			apiToken: "t",
			mappings: [{ collectionId: "col", collectionName: "Wiki", folder: "Wiki" }],
		},
		{
			resolveConflicts: async () => new Map(),
			onStatus: () => undefined,
			onError: (message) => errors.push(message),
		},
		async () => undefined,
	);

	h.app.vault.seed("Wiki/Oncall.md", withFrontmatter("Rotation\n\nMine", { outlineId: "d1" }));
	h.client.simulateRaceOn("d1", 9);
	await engine.syncAll();

	assert.equal(errors.length, 1);
	assert.ok(errors[0].includes("history"), `expected a recovery hint, got: ${errors[0]}`);
});

await test("the engine ignores the modify event caused by its own write", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();

	const written = h.app.vault.files.get("Wiki/Oncall.md") ?? "";
	assert.equal(h.engine.isSelfWrite("Wiki/Oncall.md", written), true);
	// The suppression is one-shot: a real edit afterwards must not be ignored.
	assert.equal(h.engine.isSelfWrite("Wiki/Oncall.md", written), false);
});

await test("hashing survives the frontmatter the plugin adds", async () => {
	const body = "Rotation details";
	const withMeta = withFrontmatter(body, { outlineId: "d1", outlineUrl: "https://outline.test/doc/d1" });
	assert.equal(hashBody(parseNote(withMeta).body), hashBody(body));
});

// ---- directional sync: pull-only / push-only for the status-bar buttons ----

await test("pull direction applies remote edits and ignores local edits", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation"), remoteDoc("d2", "Runbook", "Steps")]);
	await h.engine.syncAll();

	// d1 changed remotely, d2 changed locally.
	h.client.editInOutline("d1", "Rotation\n\nPrimary: Rahul");
	h.app.vault.seed("Wiki/Runbook.md", withFrontmatter("Steps\n\nNow with detail", { outlineId: "d2" }));

	const summary = await h.engine.syncAll("pull");

	assert.equal(summary.pulled, 1, "the remote edit should be pulled");
	assert.equal(summary.pushed, 0, "the local edit must not be pushed in pull mode");
	assert.ok(bodyOf(h.app, "Wiki/Oncall.md").includes("Rahul"), "d1 updated locally");
	assert.equal(h.client.updates.length, 0, "no write reached Outline");
});

await test("push direction sends local edits and ignores remote edits", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation"), remoteDoc("d2", "Runbook", "Steps")]);
	await h.engine.syncAll();

	h.client.editInOutline("d1", "Rotation\n\nPrimary: Rahul");
	h.app.vault.seed("Wiki/Runbook.md", withFrontmatter("Steps\n\nNow with detail", { outlineId: "d2" }));

	const summary = await h.engine.syncAll("push");

	assert.equal(summary.pushed, 1, "the local edit should be pushed");
	assert.equal(summary.pulled, 0, "the remote edit must not be pulled in push mode");
	assert.equal(h.client.updates.length, 1, "exactly one write reached Outline");
	assert.equal(h.client.updates[0].id, "d2");
	assert.ok(!bodyOf(h.app, "Wiki/Oncall.md").includes("Rahul"), "d1 left untouched locally");
});

await test("push direction creates local-only notes; pull direction does not", async () => {
	const h = harness([]);
	await h.engine.syncAll();
	h.app.vault.seed("Wiki/Fresh.md", "A brand new note");

	// Pull mode ignores the un-synced local note.
	const pull = await h.engine.syncAll("pull");
	assert.equal(pull.created, 0);
	assert.equal(h.client.creates.length, 0);

	// Push mode creates it in Outline.
	const push = await h.engine.syncAll("push");
	assert.equal(push.created, 1);
	assert.equal(h.client.creates.length, 1);
	assert.equal(h.client.creates[0].title, "Fresh");
});

await test("pull direction never pulls a brand-new remote document into push... wait, into pull only", async () => {
	// A remote doc the vault has never seen: pull brings it down, push leaves it.
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);

	const push = await h.engine.syncAll("push");
	assert.equal(push.pulled, 0, "push mode must not download new remote docs");
	assert.equal(h.app.vault.files.has("Wiki/Oncall.md"), false);

	const pull = await h.engine.syncAll("pull");
	assert.equal(pull.pulled, 1, "pull mode downloads it");
	assert.equal(h.app.vault.files.has("Wiki/Oncall.md"), true);
});

await test("both pull and push still raise a conflict instead of overwriting", async () => {
	for (const direction of ["pull", "push"] as const) {
		const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
		await h.engine.syncAll();
		h.app.vault.seed("Wiki/Oncall.md", withFrontmatter("Rotation\n\nPrimary: Saksham", { outlineId: "d1" }));
		h.client.editInOutline("d1", "Rotation\n\nPrimary: Rahul");

		h.answer = "skip";
		await h.engine.syncAll(direction);

		assert.equal(h.conflictsSeen.length, 1, `${direction} surfaces the conflict`);
		// Skipping leaves both sides untouched regardless of direction.
		assert.ok(bodyOf(h.app, "Wiki/Oncall.md").includes("Saksham"));
		assert.equal(h.client.updates.length, 0);
	}
});

// ---- folders as inert placeholder documents ----

await test("a note in a bare subfolder creates a folder placeholder as its parent", async () => {
	const h = harness([]); // empty Outline
	h.app.vault.seed("Wiki/Team/Oncall.md", "Rotation details");

	const summary = await h.engine.syncAll();

	assert.equal(summary.created, 1, "the note counts as one creation");
	assert.equal(h.client.creates.length, 2, "placeholder + note both created in Outline");

	const placeholder = h.client.creates.find((c) => c.title === "Team");
	const note = h.client.creates.find((c) => c.title === "Oncall");
	assert.ok(placeholder, "a 'Team' placeholder was created");
	assert.ok(placeholder!.text.includes(FOLDER_MARKER), "placeholder carries the marker");
	assert.equal(placeholder!.parentDocumentId, undefined, "placeholder sits at the collection root");
	assert.ok(note, "the note was created");
	assert.equal(note!.parentDocumentId, "new-1", "the note nests under the placeholder");
});

await test("the placeholder is never pulled into a local note, and is not recreated", async () => {
	const h = harness([]);
	h.app.vault.seed("Wiki/Team/Oncall.md", "Rotation details");
	await h.engine.syncAll();

	const summary = await h.engine.syncAll(); // second pass

	assert.equal(h.app.vault.files.has("Wiki/Team.md"), false, "no filler note appears locally");
	assert.ok(h.app.vault.folders.has("Wiki/Team"), "the folder exists locally");
	assert.equal(h.client.creates.filter((c) => c.title === "Team").length, 1, "placeholder not duplicated");
	assert.equal(summary.conflicts, 0);
});

await test("a teammate pulling a marker doc gets a bare folder with the nested note", async () => {
	const team = remoteDoc("t1", "Team", FOLDER_PLACEHOLDER_BODY);
	const child: RemoteDocument = { ...remoteDoc("c1", "Oncall", "Rotation details"), parentDocumentId: "t1" };
	const h = harness([team, child]); // fresh vault, never saw these

	const summary = await h.engine.syncAll();

	assert.ok(h.app.vault.files.has("Wiki/Team/Oncall.md"), "the note lands inside the folder");
	assert.equal(h.app.vault.files.has("Wiki/Team.md"), false, "no filler note in the sidebar");
	assert.equal(summary.pulled, 1, "only the real note is pulled");
	assert.equal(h.client.creates.length, 0, "nothing pushed back");
});

await test("edits to a placeholder in Outline are ignored", async () => {
	const team = remoteDoc("t1", "Team", FOLDER_PLACEHOLDER_BODY);
	const child: RemoteDocument = { ...remoteDoc("c1", "Oncall", "Rotation details"), parentDocumentId: "t1" };
	const h = harness([team, child]);
	await h.engine.syncAll();

	h.client.editInOutline("t1", `${FOLDER_PLACEHOLDER_BODY}\n\nsomeone typed here`);
	const summary = await h.engine.syncAll();

	assert.equal(h.app.vault.files.has("Wiki/Team.md"), false, "still no note for the folder");
	assert.equal(summary.conflicts, 0);
	assert.equal(summary.pulled, 0, "the placeholder edit is not pulled");
});

await test("two-level nesting builds a placeholder chain", async () => {
	const h = harness([]);
	h.app.vault.seed("Wiki/A/B/note.md", "hello");

	await h.engine.syncAll();

	const a = h.client.creates.find((c) => c.title === "A");
	const b = h.client.creates.find((c) => c.title === "B");
	const note = h.client.creates.find((c) => c.title === "note");
	assert.ok(a && b && note, "A, B and the note were all created");
	assert.equal(a!.parentDocumentId, undefined, "A is at the collection root");
	assert.equal(b!.parentDocumentId, "new-1", "B nests under A");
	assert.equal(note!.parentDocumentId, "new-2", "the note nests under B");
	assert.ok(a!.text.includes(FOLDER_MARKER) && b!.text.includes(FOLDER_MARKER), "both folders are placeholders");
});

await test("a locally-edited note with soft breaks is not clobbered by Outline's re-serialisation", async () => {
	const h = harness([]);
	h.app.vault.seed("Wiki/Note.md", "line one\nline two\nline three");
	await h.engine.syncAll(); // creates it, pushes encoded, baselines on stored form

	const afterCreate = h.app.vault.files.get("Wiki/Note.md");
	const summary = await h.engine.syncAll(); // must be a no-op

	assert.equal(summary.pulled, 0, "no spurious pull of our own re-serialised push");
	assert.equal(h.app.vault.files.get("Wiki/Note.md"), afterCreate, "local file untouched");
	assert.ok(bodyOf(h.app, "Wiki/Note.md").includes("line one\nline two\nline three"), "soft breaks kept locally");
});

await test("a teammate pulls soft breaks back out of Outline", async () => {
	// Outline stores the merged form with the invisible sentinel.
	const h = harness([remoteDoc("d1", "Note", "alpha⁠ beta⁠ gamma")]);
	const summary = await h.engine.syncAll();

	assert.equal(summary.pulled, 1);
	assert.equal(bodyOf(h.app, "Wiki/Note.md"), "alpha\nbeta\ngamma", "sentinels decoded to line breaks");
});

await test("moving a note into a subfolder locally pushes the move to Outline", async () => {
	const sub: RemoteDocument = remoteDoc("sub", "Sub", FOLDER_PLACEHOLDER_BODY);
	const note: RemoteDocument = remoteDoc("d1", "Note", "body text");
	const h = harness([sub, note]);
	await h.engine.syncAll(); // Wiki/Note.md at root, Wiki/Sub/ folder present

	assert.ok(h.app.vault.files.has("Wiki/Note.md"));

	// User moves the note into the Sub folder (a rename to a new path).
	const content = h.app.vault.files.get("Wiki/Note.md")!;
	h.app.vault.files.delete("Wiki/Note.md");
	h.app.vault.seed("Wiki/Sub/Note.md", content);
	h.state.relocate("Wiki/Note.md", "Wiki/Sub/Note.md");

	await h.engine.syncAll();

	assert.ok(
		h.client.moves.some((m) => m.id === "d1" && m.parentDocumentId === "sub"),
		"the note is moved under the Sub placeholder in Outline",
	);
	assert.ok(h.app.vault.files.has("Wiki/Sub/Note.md"), "stays in the subfolder locally");
	assert.ok(!h.app.vault.files.has("Wiki/Note.md"), "not reverted back to the root");
});

await test("a note the remote moved is still relocated locally", async () => {
	const sub: RemoteDocument = remoteDoc("sub", "Sub", FOLDER_PLACEHOLDER_BODY);
	const note: RemoteDocument = remoteDoc("d1", "Note", "body text");
	const h = harness([sub, note]);
	await h.engine.syncAll(); // Wiki/Note.md at root

	// Outline re-parents the note under Sub.
	const doc = h.client.documents.find((d) => d.id === "d1")!;
	doc.parentDocumentId = "sub";
	doc.updatedAt = new Date(Date.parse(doc.updatedAt) + 60_000).toISOString();

	await h.engine.syncAll();

	assert.ok(h.app.vault.files.has("Wiki/Sub/Note.md"), "local note follows the remote move");
	assert.ok(!h.app.vault.files.has("Wiki/Note.md"));
	assert.equal(h.client.moves.length, 0, "no push-back move; remote was authoritative");
});

await test("a local rename pushes the new title instead of being reverted", async () => {
	const h = harness([remoteDoc("d1", "Old Title", "body text")]);
	await h.engine.syncAll(); // pulls to Wiki/Old Title.md

	// Simulate the vault rename event: move the file and relocate the record.
	const content = h.app.vault.files.get("Wiki/Old Title.md")!;
	h.app.vault.files.delete("Wiki/Old Title.md");
	h.app.vault.seed("Wiki/New Title.md", content);
	h.state.relocate("Wiki/Old Title.md", "Wiki/New Title.md");

	await h.engine.syncAll();

	assert.ok(h.app.vault.files.has("Wiki/New Title.md"), "the rename is kept");
	assert.ok(!h.app.vault.files.has("Wiki/Old Title.md"), "not reverted to the old name");
	assert.ok(
		h.client.updates.some((u) => u.title === "New Title"),
		"the new title is pushed to Outline",
	);
});

await test("conversion off pushes raw markdown with no sentinel", async () => {
	const h = harness([], { convertMarkdown: false });
	h.app.vault.seed("Wiki/Note.md", "line one\nline two");
	await h.engine.syncAll();

	const created = h.client.creates.find((c) => c.title === "Note");
	assert.ok(created, "note created");
	assert.ok(!created!.text.includes("⁠"), "no sentinel added when conversion is off");
	assert.ok(created!.text.includes("line one\nline two"), "raw markdown sent");
});

await test("conversion off leaves Outline markdown untouched on pull", async () => {
	const h = harness([remoteDoc("d1", "Note", "* a\n* b")], { convertMarkdown: false });
	await h.engine.syncAll();
	assert.equal(bodyOf(h.app, "Wiki/Note.md"), "* a\n* b", "no canonicalisation when off");
});

await test("a remote edit that has not yet bumped Outline's revision is still pulled", async () => {
	// Regression: change detection trusted only `revision`, so edits typed in
	// Outline's editor (which lags the revision counter) were reported "synced".
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();

	h.client.editInOutlineWithoutRevisionBump("d1", "Rotation\n\nPrimary: Rahul");
	const summary = await h.engine.syncAll();

	assert.equal(summary.pulled, 1, "the edit should be pulled despite the unchanged revision");
	assert.ok(bodyOf(h.app, "Wiki/Oncall.md").includes("Rahul"));
});

await test("a note missing from the listing is NOT trashed while Outline still has it", async () => {
	// Regression: nested docs were absent from a root-only listing, so the sync
	// trashed the local notes even though Outline still had them.
	const h = harness([remoteDoc("d1", "Oncall", "Rotation")]);
	await h.engine.syncAll();
	assert.ok(h.app.vault.files.has("Wiki/Oncall.md"));

	h.client.hideFromList("d1"); // present via getDocument, absent from the list
	const summary = await h.engine.syncAll();

	assert.ok(h.app.vault.files.has("Wiki/Oncall.md"), "the note is kept, not trashed");
	assert.equal(h.app.vault.trashed.includes("Wiki/Oncall.md"), false);
	assert.equal(summary.deleted, 0, "nothing counted as deleted");
	assert.ok(h.state.get("d1"), "the sync record is kept");
});

// ---- non-markdown file sync (attachment-wrapped file documents) ----

await test("a local non-markdown file syncs as a file document", async () => {
	const h = harness([], { syncFileExtensions: ["html"] });
	h.app.vault.binaries.set("Wiki/report.html", new TextEncoder().encode("<h1>Report</h1>").buffer);

	const summary = await h.engine.syncAll();

	const created = h.client.creates.find((c) => c.title === "report.html");
	assert.ok(created, "a file document was created");
	assert.ok(created!.text.includes("outline-sync:file"), "it carries the file marker");
	assert.ok(created!.text.includes("attachments.redirect"), "it links to the attachment");
	assert.equal(h.client.attachments.size, 1, "the file was uploaded as an attachment");
	assert.equal(summary.created, 1);
});

await test("a file document downloads the file into the vault", async () => {
	const attId = "00000000-0000-0000-0000-000000000009";
	const wrapper = remoteDoc("f1", "report.html", buildFileWrapper("report.html", attId));
	const h = harness([wrapper], { syncFileExtensions: ["html"] });
	h.client.attachments.set(attId, new TextEncoder().encode("<h1>Report</h1>").buffer);

	const summary = await h.engine.syncAll();

	assert.ok(h.app.vault.binaries.has("Wiki/report.html"), "the file is written locally");
	assert.equal(
		new TextDecoder().decode(h.app.vault.binaries.get("Wiki/report.html")),
		"<h1>Report</h1>",
		"bytes preserved exactly",
	);
	assert.equal(summary.pulled, 1);
});

await test("an unchanged file is not re-uploaded on a quiet sync", async () => {
	const h = harness([], { syncFileExtensions: ["html"] });
	h.app.vault.binaries.set("Wiki/report.html", new TextEncoder().encode("stable").buffer);
	await h.engine.syncAll();

	const before = h.client.attachments.size;
	const summary = await h.engine.syncAll();

	assert.equal(h.client.attachments.size, before, "no new attachment uploaded");
	assert.equal(summary.created + summary.pushed + summary.pulled, 0, "nothing to do");
});

await test("duplicate file documents for one file are collapsed", async () => {
	const attId = "00000000-0000-0000-0000-000000000009";
	const w1 = remoteDoc("f1", "report.html", buildFileWrapper("report.html", attId));
	const w2 = remoteDoc("f2", "report.html", buildFileWrapper("report.html", attId));
	const h = harness([w1, w2], { syncFileExtensions: ["html"] });
	h.client.attachments.set(attId, new TextEncoder().encode("x").buffer);

	const summary = await h.engine.syncAll();

	assert.equal(h.client.deletes.length, 1, "one of the two duplicates is deleted");
	assert.equal(summary.deleted, 1);
});

await test("a file deleted in Outline is trashed locally when deletes propagate", async () => {
	const h = harness([], { syncFileExtensions: ["html"] }); // propagateRemoteDeletes on by default
	h.app.vault.binaries.set("Wiki/report.html", new TextEncoder().encode("a").buffer);
	await h.engine.syncAll();
	const wrapperId = h.client.documents.find((d) => d.title === "report.html")!.id;

	h.client.removeFromOutline(wrapperId);
	await h.engine.syncAll();

	assert.ok(h.app.vault.trashed.includes("Wiki/report.html"), "local file sent to trash");
	assert.equal(h.client.creates.filter((c) => c.title === "report.html").length, 1, "not re-uploaded");
});

await test("a file deleted in Outline is re-uploaded when deletes don't propagate", async () => {
	const h = harness([], { syncFileExtensions: ["html"], propagateRemoteDeletes: false });
	h.app.vault.binaries.set("Wiki/report.html", new TextEncoder().encode("a").buffer);
	await h.engine.syncAll();
	const wrapperId = h.client.documents.find((d) => d.title === "report.html")!.id;

	h.client.removeFromOutline(wrapperId);
	await h.engine.syncAll();

	assert.ok(h.app.vault.binaries.has("Wiki/report.html"), "local file kept");
	assert.equal(h.client.creates.filter((c) => c.title === "report.html").length, 2, "uploaded again, fresh");
	const third = await h.engine.syncAll();
	assert.equal(third.created, 0, "and then stays in sync");
});

await test("only allow-listed extensions sync; others are ignored", async () => {
	const h = harness([], { syncFileExtensions: ["html"] });
	h.app.vault.binaries.set("Wiki/report.html", new TextEncoder().encode("a").buffer);
	h.app.vault.binaries.set("Wiki/photo.png", new TextEncoder().encode("b").buffer);

	await h.engine.syncAll();

	assert.ok(h.client.creates.some((c) => c.title === "report.html"), "html synced");
	assert.ok(!h.client.creates.some((c) => c.title === "photo.png"), "png ignored (not allow-listed)");
});

await test("a suppressed synced note is not pulled back or overwritten", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation details")]);
	await h.engine.syncAll();

	const kept = withFrontmatter("Rotation details\n\nLocal only", {
		outlineId: "d1",
		outlineSuppressed: true,
	});
	h.app.vault.seed("Wiki/Oncall.md", kept);
	h.client.editInOutline("d1", "Rotation details\n\nFrom Outline");
	const summary = await h.engine.syncAll();

	assert.equal(summary.pulled, 0);
	assert.equal(h.client.updates.length, 0);
	assert.equal(h.app.vault.files.get("Wiki/Oncall.md"), kept);
	assert.equal(h.app.vault.trashed.length, 0);
});

await test("a suppressed synced note is not pushed", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation details")]);
	await h.engine.syncAll();
	const file = h.app.vault.getFileByPath("Wiki/Oncall.md");
	assert.ok(file);
	h.app.vault.seed(
		"Wiki/Oncall.md",
		withFrontmatter("Rotation details\n\nLocal only", { outlineId: "d1", outlineSuppressed: true }),
	);

	const outcome = await h.engine.pushNote(file!);
	assert.equal(outcome, "skipped");
	assert.equal(h.client.updates.length, 0);
});

await test("a new suppressed note is not created in Outline", async () => {
	const h = harness([]);
	h.app.vault.seed("Wiki/Private.md", withFrontmatter("Stay local", { outlineSuppressed: true }));

	const summary = await h.engine.syncAll();

	assert.equal(summary.created, 0);
	assert.equal(h.client.creates.length, 0);
	assert.equal(h.app.vault.files.get("Wiki/Private.md")?.includes("Stay local"), true);
});

await test("deleting the remote copy does not trash a suppressed note", async () => {
	const h = harness([remoteDoc("d1", "Oncall", "Rotation details")]);
	await h.engine.syncAll();
	h.app.vault.seed(
		"Wiki/Oncall.md",
		withFrontmatter("Rotation details", { outlineId: "d1", outlineSuppressed: true }),
	);

	h.client.removeFromOutline("d1");
	const summary = await h.engine.syncAll();

	assert.equal(summary.deleted, 0);
	assert.ok(h.app.vault.files.has("Wiki/Oncall.md"));
	assert.equal(h.app.vault.trashed.length, 0);
});

for (const failure of failures) console.error(failure);
console.log(`${passed} passed, ${failures.length} failed`);
