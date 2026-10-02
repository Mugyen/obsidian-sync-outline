/** Frontmatter keys this plugin owns. Everything else is passed through. */
export interface OutlineFrontmatter {
	outlineId?: string;
	outlineUrl?: string;
	[key: string]: unknown;
}

export interface ParsedNote {
	frontmatter: OutlineFrontmatter;
	/** Note content with the frontmatter block removed. */
	body: string;
	/** Raw frontmatter block including delimiters, or "" when absent. */
	rawFrontmatter: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Splits a note into frontmatter and body.
 *
 * Deliberately a flat scalar parser rather than full YAML: the only keys
 * that must round-trip precisely are ours, and unknown lines are kept
 * verbatim so a user's Dataview or Templater properties survive a sync.
 */
export function parseNote(content: string): ParsedNote {
	const match = FRONTMATTER_PATTERN.exec(content);
	if (!match) {
		return { frontmatter: {}, body: content, rawFrontmatter: "" };
	}

	const frontmatter: OutlineFrontmatter = {};
	for (const line of match[1].split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator === -1 || line.trimStart().startsWith("#")) continue;
		const key = line.slice(0, separator).trim();
		if (!key) continue;
		frontmatter[key] = unquote(line.slice(separator + 1).trim());
	}

	return {
		frontmatter,
		body: content.slice(match[0].length),
		rawFrontmatter: match[0],
	};
}

/** Rewrites a note, updating only the keys given and preserving the rest. */
export function withFrontmatter(content: string, updates: OutlineFrontmatter): string {
	const parsed = parseNote(content);
	const merged: Record<string, unknown> = { ...parsed.frontmatter };
	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined || value === null) delete merged[key];
		else merged[key] = value;
	}

	const keys = Object.keys(merged);
	if (keys.length === 0) return parsed.body;

	const lines = keys.map((key) => `${key}: ${formatScalar(merged[key])}`);
	return `---\n${lines.join("\n")}\n---\n${parsed.body}`;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"');
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1);
	}
	return value;
}

function formatScalar(value: unknown): string {
	const text = String(value);
	// Quote anything YAML would otherwise reinterpret.
	return /^[\w./:-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
}

/**
 * Normalises a body before hashing or comparing.
 *
 * Outline and Obsidian disagree harmlessly about line endings and
 * trailing whitespace; without this every sync would look like an edit.
 */
export function normalizeBody(body: string): string {
	return body.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/**
 * FNV-1a, 64-bit, as hex.
 *
 * Hand-rolled because SubtleCrypto is async and node:crypto is absent on
 * Obsidian mobile. Collision risk is irrelevant here: the hash only ever
 * answers "is this the same text I last saw".
 */
export function hashBody(body: string): string {
	const normalized = normalizeBody(body);
	let high = 0xcbf2_9ce4;
	let low = 0x8422_2325;
	for (let i = 0; i < normalized.length; i++) {
		low ^= normalized.charCodeAt(i);
		const lowMultiplied = low * 0x1b3;
		const highMultiplied = high * 0x1b3 + Math.floor(lowMultiplied / 0x1_0000_0000);
		low = lowMultiplied >>> 0;
		high = highMultiplied >>> 0;
	}
	return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

/**
 * A non-markdown file (report.html, a PDF, …) can't be an Outline document, so
 * it is stored as an attachment wrapped in a small "file document": the body is
 * a download link to the attachment plus a marker so any machine recognises it
 * and rebuilds the local file instead of treating it as a note.
 */
export const FILE_MARKER = "outline-sync:file";

export function buildFileWrapper(name: string, attachmentId: string): string {
	// The link text is for people; Outline reformats it (it pads `[x]` to
	// `[ x]`). The exact filename rides in the marker comment, which Outline
	// stores verbatim.
	return (
		`[${name}](/api/attachments.redirect?id=${attachmentId})\n\n` +
		`<!--${FILE_MARKER} name="${encodeURIComponent(name)}"-->`
	);
}

export function isFileWrapper(text: string): boolean {
	return text.includes(FILE_MARKER);
}

/** Extracts the filename and attachment id from a file-wrapper document. */
export function parseFileWrapper(text: string): { name: string; attachmentId: string } | null {
	if (!isFileWrapper(text)) return null;
	const match = /!?\[([^\]]+)\]\(\/api\/attachments\.redirect\?id=([a-f0-9-]{36})/i.exec(text);
	if (!match) return null;
	const exact = new RegExp(`<!--${FILE_MARKER} name="([^"]*)"-->`).exec(text);
	if (exact) {
		try {
			return { name: decodeURIComponent(exact[1]), attachmentId: match[2] };
		} catch {
			// malformed encoding: fall through to the link text
		}
	}
	// Wrappers from 0.6.0 carry no name attribute. Outline pads link text
	// (`[ report.html]`), so trim it.
	return { name: match[1].trim(), attachmentId: match[2] };
}

/** FNV-1a over raw bytes, matching hashBody's scheme, for binary change detection. */
export function hashBytes(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	let high = 0xcbf2_9ce4;
	let low = 0x8422_2325;
	for (let i = 0; i < bytes.length; i++) {
		low ^= bytes[i];
		const lowMultiplied = low * 0x1b3;
		const highMultiplied = high * 0x1b3 + Math.floor(lowMultiplied / 0x1_0000_0000);
		low = lowMultiplied >>> 0;
		high = highMultiplied >>> 0;
	}
	return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

/**
 * Outline stores rich text and regenerates markdown on read, so a push→pull
 * round-trip is lossy. Two things bridge the gap:
 *
 *  - Outline collapses a single line break (a "soft break") inside a block into
 *    a space, destroying it. We mark each soft break with an invisible U+2060
 *    WORD JOINER before pushing; Outline keeps the marker (and adds its own
 *    space), so we can restore the exact break on pull. The joiner is invisible
 *    in both Obsidian and Outline.
 *  - Outline rewrites list bullets to "*" and escapes characters like -, [, ~.
 *    We canonicalise those back to Obsidian's conventions on pull.
 */
export const SOFT_BREAK_SENTINEL = "⁠";

const FENCE = /^\s*(```|~~~)/;
const BLOCK_LINE =
	/^(\s*#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|\s*\||\s*(```|~~~)|\s*(-{3,}|\*{3,}|_{3,})\s*$|( {4,}|\t)\S)/;

/** True for a line that is its own block and must never be joined to a neighbour. */
function isBlockLine(line: string): boolean {
	return BLOCK_LINE.test(line);
}

/**
 * Marks paragraph-internal soft breaks so Outline preserves them. Only joins two
 * consecutive plain-text lines — never list items, headings, code, or blanks.
 */
export function encodeForOutline(body: string): string {
	const lines = body.replace(new RegExp(SOFT_BREAK_SENTINEL, "g"), "").split("\n");
	let inFence = false;
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (FENCE.test(line)) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		const next = lines[i + 1];
		const isSoftBreak =
			!inFence &&
			next !== undefined &&
			line.trim() !== "" &&
			next.trim() !== "" &&
			!isBlockLine(line) &&
			!isBlockLine(next);
		out.push(isSoftBreak ? line + SOFT_BREAK_SENTINEL : line);
	}
	return out.join("\n");
}

/** Turns Outline's markdown back into clean Obsidian markdown. */
export function decodeFromOutline(text: string): string {
	const decoded = text
		// Restore soft breaks: the sentinel (plus the space Outline inserts) → newline.
		.replace(new RegExp(SOFT_BREAK_SENTINEL + " ?", "g"), "\n")
		// Outline serialises unordered lists with "*"; Obsidian's convention is "-".
		.replace(/^(\s*)\* /gm, "$1- ")
		// Outline escapes characters that need no escaping in Obsidian prose.
		.replace(/\\([-[\]~])/g, "$1");
	return normalizeListsForObsidian(decoded);
}

const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;

/** Visual width of leading whitespace, with tabs to the next multiple of 4 (CommonMark). */
function columnsOf(whitespace: string): number {
	let column = 0;
	for (const char of whitespace) column = char === "\t" ? column + 4 - (column % 4) : column + 1;
	return column;
}

interface OpenItem {
	/** Column where this item's content starts in Outline's text. */
	sourceContent: number;
	/** Indentation we emitted for the item. */
	prefix: string;
	/** Column where the item's content starts in what we emit. */
	content: number;
	/** Nested items emitted so far. */
	children: number;
}

/** Indentation for a line nested inside `parent`: a tab when that nests correctly, else spaces. */
function nestedPrefix(parent: OpenItem): string {
	const tabbed = parent.prefix + "\t";
	const width = columnsOf(tabbed);
	return width >= parent.content && width <= parent.content + 3 ? tabbed : " ".repeat(parent.content);
}

/**
 * Re-indents lists the way Obsidian writes them. Outline serialises nesting with
 * ragged indentation (" 1." beside "10.", children at 3, 4 or 7 spaces) and puts
 * a blank line plus a whitespace-only line before every sub-list. That is valid
 * CommonMark and renders fine in Outline, but in Obsidian it is a mess. The
 * nesting is kept exactly; only the layout changes: tight, tab-indented lists.
 */
export function normalizeListsForObsidian(text: string): string {
	const out: string[] = [];
	const open: OpenItem[] = [];
	let blanks = 0;
	let inFence = false;

	const flushBlanks = () => {
		for (; blanks > 0; blanks--) out.push("");
	};
	const closeTo = (indent: number) => {
		while (open.length > 0 && indent < open[open.length - 1].sourceContent) open.pop();
	};

	for (const line of text.split("\n")) {
		if (inFence || FENCE.test(line)) {
			// Code is never re-indented, and a fence inside a list ends our tracking.
			if (FENCE.test(line)) inFence = !inFence;
			flushBlanks();
			open.length = 0;
			out.push(line);
			continue;
		}
		if (line.trim() === "") {
			blanks++;
			continue;
		}

		const indent = columnsOf(/^[ \t]*/.exec(line)?.[0] ?? "");
		const item = LIST_ITEM.exec(line);

		if (item) {
			closeTo(indent);
			const marker = item[2];
			const parent = open[open.length - 1];
			if (parent) {
				// Blank lines between an item and its sub-list are Outline's artifact —
				// except that an ordered sub-list not starting at 1 cannot interrupt the
				// parent's text in CommonMark, so it needs one to stay a list.
				const startsAtOtherThanOne = /^\d/.test(marker) && Number.parseInt(marker, 10) !== 1;
				blanks = parent.children === 0 && startsAtOtherThanOne ? Math.min(blanks, 1) : 0;
				parent.children++;
			}
			flushBlanks();
			const gap = item[3] ?? " ";
			const gapWidth = gap.length >= 1 && gap.length <= 4 && !gap.includes("\t") ? gap.length : 1;
			const prefix = parent ? nestedPrefix(parent) : "";
			out.push(prefix + marker + (item[4] ? ` ${item[4]}` : ""));
			open.push({
				sourceContent: indent + marker.length + gapWidth,
				prefix,
				content: columnsOf(prefix) + marker.length + 1,
				children: 0,
			});
			continue;
		}

		if (open.length > 0) {
			if (blanks === 0) {
				// Continuation of the item just above, however it was indented.
				out.push(nestedPrefix(open[open.length - 1]) + line.trimStart());
				continue;
			}
			closeTo(indent);
			if (open.length > 0) {
				flushBlanks();
				out.push(nestedPrefix(open[open.length - 1]) + line.trimStart());
				continue;
			}
		}
		flushBlanks();
		out.push(line);
	}
	flushBlanks();
	return out.join("\n");
}

const OUTLINE_ATTACHMENT = /!\[([^\]]*)\]\((\/api\/attachments\.redirect\?id=([a-f0-9-]{36})[^)]*)\)/gi;
// Targets are matched lazily so unencoded spaces survive: pasted
// screenshots are routinely named "Screenshot 2026-09-07 at 10.14.png".
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*([^)]*?)\s*(\s"[^"]*")?\)/g;
const WIKI_EMBED = /!\[\[([^\]|]+)(\|[^\]]*)?\]\]/g;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface AttachmentReference {
	attachmentId: string;
	alt: string;
	/** The full URL as it appears inside the document text. */
	url: string;
}

/** Finds Outline-hosted images in document text. */
export function findOutlineAttachments(text: string): AttachmentReference[] {
	const references: AttachmentReference[] = [];
	for (const match of text.matchAll(OUTLINE_ATTACHMENT)) {
		references.push({ alt: match[1], url: match[2], attachmentId: match[3] });
	}
	return references;
}

/** Points Outline attachment links at local files after download. */
export function rewriteAttachmentsToLocal(
	text: string,
	resolve: (attachmentId: string) => string | undefined,
): string {
	return text.replace(OUTLINE_ATTACHMENT, (whole, alt: string, _url: string, id: string) => {
		const localPath = resolve(id);
		return localPath ? `![${alt}](${encodeURI(localPath)})` : whole;
	});
}

export interface LocalImageReference {
	/** Link target as written in the note. */
	target: string;
	alt: string;
	/** Set when the file is an already-known Outline attachment. */
	attachmentId?: string;
	/** True for Obsidian's ![[embed]] syntax, which Outline cannot render. */
	isWikiEmbed: boolean;
}

/** Finds images in a local note that may need uploading before a push. */
export function findLocalImages(body: string): LocalImageReference[] {
	const images: LocalImageReference[] = [];

	for (const match of body.matchAll(MARKDOWN_IMAGE)) {
		const target = decodeTarget(match[2]);
		if (!target) continue;
		if (/^(https?:)?\/\//.test(target) || target.startsWith("/api/attachments")) continue;
		images.push({ target, alt: match[1], attachmentId: attachmentIdFor(target), isWikiEmbed: false });
	}
	for (const match of body.matchAll(WIKI_EMBED)) {
		const target = match[1].trim();
		images.push({ target, alt: "", attachmentId: attachmentIdFor(target), isWikiEmbed: true });
	}
	return images;
}

/** Unwraps <angle brackets> and percent-encoding from a link target. */
function decodeTarget(raw: string): string {
	const trimmed = raw.trim().replace(/^<|>$/g, "");
	try {
		return decodeURI(trimmed);
	} catch {
		return trimmed; // a stray % is not our problem to fix
	}
}

/** Files we downloaded are named <attachmentId>.<ext>, so identity is in the name. */
function attachmentIdFor(target: string): string | undefined {
	const filename = target.split("/").pop() ?? "";
	const stem = filename.slice(0, filename.lastIndexOf(".") === -1 ? undefined : filename.lastIndexOf("."));
	return UUID.test(stem) ? stem : undefined;
}

/** Replaces one image link with an Outline attachment URL, in both syntaxes. */
export function rewriteImageToOutline(
	body: string,
	image: LocalImageReference,
	attachmentId: string,
): string {
	const outlineUrl = `/api/attachments.redirect?id=${attachmentId}`;
	if (image.isWikiEmbed) {
		return body.replace(
			new RegExp(`!\\[\\[${escapeRegExp(image.target)}(\\|[^\\]]*)?\\]\\]`, "g"),
			`![${image.alt}](${outlineUrl})`,
		);
	}
	return body.replace(MARKDOWN_IMAGE, (whole, alt: string, target: string, title?: string) => {
		if (decodeTarget(target) !== image.target) return whole;
		return `![${alt}](${outlineUrl}${title ?? ""})`;
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EXTENSION_BY_TYPE: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"application/pdf": "pdf",
};

export function extensionForContentType(contentType: string): string {
	return EXTENSION_BY_TYPE[contentType.split(";")[0].trim().toLowerCase()] ?? "bin";
}

const TYPE_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	pdf: "application/pdf",
};

export function contentTypeForPath(path: string): string {
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	return TYPE_BY_EXTENSION[extension] ?? "application/octet-stream";
}
