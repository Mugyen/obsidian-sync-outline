/* Exercises the modules that do not touch Obsidian's API. Run: npm test */
import assert from "node:assert/strict";

import { diffLines, withContext, countChanges } from "../src/sync/diff";
import {
	SOFT_BREAK_SENTINEL,
	buildFileWrapper as buildFileWrapperFn,
	decodeFromOutline,
	encodeForOutline,
	parseFileWrapper,
	findLocalImages,
	findOutlineAttachments,
	hashBody,
	isOutlineSuppressed,
	normalizeBody,
	parseNote,
	rewriteAttachmentsToLocal,
	rewriteImageToOutline,
	setFrontmatterScalar,
	withFrontmatter,
} from "../src/sync/markdown";
import { pathForDocument, safeFileName, titleFromPath, withSuffix } from "../src/sync/paths";
import type { RemoteDocument } from "../src/types";

let passed = 0;
function test(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
	} catch (error) {
		console.error(`FAIL  ${name}\n      ${String(error)}`);
		process.exitCode = 1;
	}
}

// ---------- frontmatter ----------

test("parses frontmatter and body", () => {
	const parsed = parseNote("---\noutlineId: abc-123\ntags: one\n---\n# Title\n\nBody text\n");
	assert.equal(parsed.frontmatter.outlineId, "abc-123");
	assert.equal(parsed.body, "# Title\n\nBody text\n");
});

test("handles a note with no frontmatter", () => {
	const parsed = parseNote("Just a body\n");
	assert.deepEqual(parsed.frontmatter, {});
	assert.equal(parsed.body, "Just a body\n");
});

test("preserves unrelated frontmatter keys through a write", () => {
	const original = "---\ntags: research\naliases: Foo\n---\nBody\n";
	const updated = withFrontmatter(original, { outlineId: "doc-1" });
	const parsed = parseNote(updated);
	assert.equal(parsed.frontmatter.tags, "research");
	assert.equal(parsed.frontmatter.aliases, "Foo");
	assert.equal(parsed.frontmatter.outlineId, "doc-1");
	assert.equal(parsed.body, "Body\n");
});

test("quotes values that YAML would misread", () => {
	const written = withFrontmatter("Body", { outlineUrl: "https://x.test/doc/a: b" });
	assert.ok(written.includes('outlineUrl: "https://x.test/doc/a: b"'));
	assert.equal(parseNote(written).frontmatter.outlineUrl, "https://x.test/doc/a: b");
});

test("frontmatter round-trips without drift", () => {
	const once = withFrontmatter("Body\n", { outlineId: "d1" });
	const twice = withFrontmatter(once, { outlineId: "d1" });
	assert.equal(once, twice);
});

test("inserts a checkbox without rewriting the rest of the block", () => {
	const original = "---\ntags:\n  - research\naliases:\n  - Foo\n---\nBody\n";
	const updated = setFrontmatterScalar(original, "outlineSuppressed", false);
	assert.ok(updated.includes("tags:\n  - research\n"));
	assert.ok(updated.includes("aliases:\n  - Foo\n"));
	assert.ok(updated.includes("outlineSuppressed: false\n"));
	assert.equal(parseNote(updated).body, "Body\n");
	assert.equal(isOutlineSuppressed(parseNote(updated).frontmatter), false);
});

test("updates an existing checkbox line in place", () => {
	const original = "---\ntags:\n  - research\noutlineSuppressed: false\n---\nBody\n";
	const updated = setFrontmatterScalar(original, "outlineSuppressed", true);
	assert.ok(updated.includes("tags:\n  - research\n"));
	assert.ok(updated.includes("outlineSuppressed: true\n"));
	assert.equal(isOutlineSuppressed(parseNote(updated).frontmatter), true);
});

// ---------- hashing ----------

test("hash ignores line endings and trailing whitespace", () => {
	assert.equal(hashBody("a\r\nb  \n"), hashBody("a\nb"));
});

test("hash separates genuinely different text", () => {
	assert.notEqual(hashBody("Primary: Rahul"), hashBody("Primary: Saksham"));
});

test("normalizeBody trims consistently", () => {
	assert.equal(normalizeBody("\n\n text \n\n"), "text");
});

// ---------- attachments ----------

test("finds Outline attachment references", () => {
	const text = "Intro\n\n![diagram](/api/attachments.redirect?id=1b9a2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d)\n";
	const found = findOutlineAttachments(text);
	assert.equal(found.length, 1);
	assert.equal(found[0].attachmentId, "1b9a2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d");
	assert.equal(found[0].alt, "diagram");
});

test("rewrites attachments to local paths", () => {
	const id = "1b9a2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
	const text = `![diagram](/api/attachments.redirect?id=${id})`;
	const rewritten = rewriteAttachmentsToLocal(text, () => `Outline Attachments/${id}.png`);
	assert.equal(rewritten, `![diagram](Outline%20Attachments/${id}.png)`);
});

test("leaves attachments alone when the download failed", () => {
	const text = "![x](/api/attachments.redirect?id=1b9a2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d)";
	assert.equal(rewriteAttachmentsToLocal(text, () => undefined), text);
});

test("recognises a downloaded attachment by its filename", () => {
	const id = "1b9a2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
	const images = findLocalImages(`![x](Outline%20Attachments/${id}.png)`);
	assert.equal(images.length, 1);
	assert.equal(images[0].attachmentId, id);
});

test("treats a pasted screenshot as new", () => {
	const images = findLocalImages("![](assets/Screenshot 2026-09-07.png)");
	assert.equal(images.length, 1);
	assert.equal(images[0].attachmentId, undefined);
});

test("finds Obsidian wiki embeds", () => {
	const images = findLocalImages("![[diagram.png|400]]");
	assert.equal(images.length, 1);
	assert.equal(images[0].isWikiEmbed, true);
	assert.equal(images[0].target, "diagram.png");
});

test("converts a wiki embed to an Outline attachment link", () => {
	const body = "before\n![[diagram.png|400]]\nafter";
	const result = rewriteImageToOutline(body, findLocalImages(body)[0], "aaaa1111-2222-4333-8444-555566667777");
	assert.ok(result.includes("![](/api/attachments.redirect?id=aaaa1111-2222-4333-8444-555566667777)"));
	assert.ok(!result.includes("![["));
});

test("ignores remote images on push", () => {
	assert.equal(findLocalImages("![x](https://example.test/a.png)").length, 0);
});

// ---------- paths ----------

test("makes titles safe for the filesystem", () => {
	assert.equal(safeFileName("SF Visit P1: Vedant"), "SF Visit P1- Vedant");
	assert.equal(safeFileName("a/b\\c*d?e"), "a-b-c-d-e");
	assert.equal(safeFileName("   "), "Untitled");
});

test("truncates very long titles", () => {
	assert.ok(safeFileName("x".repeat(400)).length <= 120);
});

test("nests child documents under a folder named for the parent", () => {
	const parent = doc("p1", "Engineering Handbook");
	const child = doc("c1", "Oncall", "p1");
	const byId = new Map([
		[parent.id, parent],
		[child.id, child],
	]);
	assert.equal(pathForDocument(parent, byId, "Wiki"), "Wiki/Engineering Handbook.md");
	assert.equal(pathForDocument(child, byId, "Wiki"), "Wiki/Engineering Handbook/Oncall.md");
});

test("survives a parent cycle rather than hanging", () => {
	const a = doc("a", "A", "b");
	const b = doc("b", "B", "a");
	const byId = new Map([
		[a.id, a],
		[b.id, b],
	]);
	assert.ok(pathForDocument(a, byId, "W").endsWith(".md"));
});

test("derives the title from the filename", () => {
	assert.equal(titleFromPath("Wiki/Engineering/Oncall.md"), "Oncall");
});

test("suffixes before the extension", () => {
	assert.equal(withSuffix("a/b.md", " (Outline)"), "a/b (Outline).md");
});

// ---------- diff ----------

test("diffs two versions of a line", () => {
	const lines = diffLines("Primary: Rahul", "Primary: Saksham");
	const counts = countChanges(lines);
	assert.equal(counts.removed, 1);
	assert.equal(counts.added, 1);
});

test("reports no changes for identical text", () => {
	assert.deepEqual(countChanges(diffLines("same\ntext", "same\ntext")), { added: 0, removed: 0 });
});

test("collapses unchanged runs", () => {
	const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
	const after = before.replace("line 30", "line 30 edited");
	const collapsed = withContext(diffLines(before, after));
	assert.ok(collapsed.length < 20, `expected a collapsed diff, got ${collapsed.length} lines`);
	assert.ok(collapsed.some((line) => line.text === "…"));
});

function doc(id: string, title: string, parentDocumentId?: string): RemoteDocument {
	return {
		id,
		urlId: id,
		title,
		text: "",
		revision: 1,
		updatedAt: new Date().toISOString(),
		collectionId: "col",
		parentDocumentId,
	};
}

// ---------- Outline markdown conversion ----------

// Mimics what Outline does to our pushed markdown: it merges soft-broken lines
// (turning "x<sentinel>\ny" into "x<sentinel> y") and rewrites "-" bullets to "*".
function simulateOutlineStore(pushed: string): string {
	return pushed
		.replace(new RegExp(SOFT_BREAK_SENTINEL + "\\n", "g"), SOFT_BREAK_SENTINEL + " ")
		.replace(/^(\s*)- /gm, "$1* ");
}

test("encode marks paragraph soft breaks but leaves blocks alone", () => {
	assert.equal(
		encodeForOutline("line one\nline two\nline three"),
		`line one${SOFT_BREAK_SENTINEL}\nline two${SOFT_BREAK_SENTINEL}\nline three`,
	);
	// list items, headings and blank-line paragraphs are never joined
	assert.equal(encodeForOutline("- a\n- b"), "- a\n- b");
	assert.equal(encodeForOutline("## Heading\ntext below"), "## Heading\ntext below");
	assert.equal(encodeForOutline("para one\n\npara two"), "para one\n\npara two");
});

test("encode never touches inside a fenced code block", () => {
	const code = "```py\na = 1\nb = 2\n```";
	assert.equal(encodeForOutline(code), code);
});

test("a soft-break paragraph survives the full round-trip byte-for-byte", () => {
	const original = "line one\nline two\nline three";
	const restored = decodeFromOutline(simulateOutlineStore(encodeForOutline(original)));
	assert.equal(restored, original);
});

test("file wrapper name is trimmed of Outline's link-text padding", () => {
	// Outline stores our `[report.html]` as `[ report.html]`.
	const parsed = parseFileWrapper("[ report.html](/api/attachments.redirect?id=7a24069a-bf14-4030-b0ec-5c31d1d9f5fe)\n\n<!--outline-sync:file-->");
	assert.ok(parsed);
	assert.equal(parsed!.name, "report.html", "leading space stripped");
});

test("file wrapper carries the exact filename, even one Outline would reformat", () => {
	const id = "7a24069a-bf14-4030-b0ec-5c31d1d9f5fe";
	for (const name of ["report.html", " spaced.html", 'odd "quote" name.pdf']) {
		// Simulate Outline padding the link text; the comment is kept verbatim.
		const stored = buildFileWrapperFn(name, id).replace(/\[([^\]]+)\]/, "[ $1]");
		assert.deepEqual(parseFileWrapper(stored), { name, attachmentId: id });
	}
});

test("decode canonicalises Outline markdown to Obsidian style", () => {
	assert.equal(decodeFromOutline("* a\n  * b"), "- a\n  - b");
	assert.equal(decodeFromOutline("\\-> arrow \\[bracket\\] \\~tilde"), "-> arrow [bracket] ~tilde");
});

test("real paragraph breaks are preserved through the round-trip", () => {
	const original = "first para line a\nfirst para line b\n\nsecond para";
	const restored = decodeFromOutline(simulateOutlineStore(encodeForOutline(original)));
	assert.equal(restored, original);
});

console.log(`${passed} passed${process.exitCode ? "" : ", 0 failed"}`);
