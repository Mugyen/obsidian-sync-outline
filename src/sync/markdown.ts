/** Frontmatter keys this plugin owns. Everything else is passed through. */
export interface OutlineFrontmatter {
	outlineId?: string;
	outlineUrl?: string;
	outlineSuppressed?: boolean;
	/** ISO timestamp of the last successful sync before suppression was enabled. */
	outlineLastsync?: string;
	[key: string]: unknown;
}

/** Returns true if the note's frontmatter has outlineSuppressed set to a truthy value. */
export function isOutlineSuppressed(frontmatter: Record<string, unknown>): boolean {
	const v = frontmatter.outlineSuppressed;
	if (typeof v === "boolean") return v;
	if (typeof v === "string") {
		const s = v.toLowerCase().trim();
		return s === "true" || s === "1" || s === "yes" || s === "on";
	}
	return false;
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
	return text
		// Restore soft breaks: the sentinel (plus the space Outline inserts) → newline.
		.replace(new RegExp(SOFT_BREAK_SENTINEL + " ?", "g"), "\n")
		// Outline serialises unordered lists with "*"; Obsidian's convention is "-".
		.replace(/^(\s*)\* /gm, "$1- ")
		// Outline escapes characters that need no escaping in Obsidian prose.
		.replace(/\\([-[\]~])/g, "$1");
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
