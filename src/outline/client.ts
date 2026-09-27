import { requestUrl, type RequestUrlResponse } from "obsidian";

import type { AttachmentUpload, OutlineCollection, RemoteDocument } from "../types";

export class OutlineApiError extends Error {
	constructor(
		readonly endpoint: string,
		readonly status: number,
		message: string,
	) {
		super(`Outline ${endpoint} failed (${status}): ${message}`);
		this.name = "OutlineApiError";
	}
}

interface ListResponse<T> {
	data: T[];
	pagination?: { limit: number; offset: number };
}

/**
 * Thin Outline API client built on Obsidian's requestUrl.
 *
 * requestUrl rather than fetch: plugins run in a renderer with an
 * app:// origin, and Outline sends no CORS headers for it, so fetch is
 * blocked before the request leaves the machine.
 */
export class OutlineClient {
	constructor(
		private baseUrl: string,
		private token: string,
	) {}

	get apiUrl(): string {
		return `${this.baseUrl.replace(/\/+$/, "")}/api`;
	}

	get origin(): string {
		return this.baseUrl.replace(/\/+$/, "");
	}

	private async post<T>(endpoint: string, body: unknown): Promise<T> {
		let response: RequestUrlResponse;
		try {
			response = await requestUrl({
				url: `${this.apiUrl}/${endpoint}`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(body ?? {}),
				throw: false,
			});
		} catch (error) {
			throw new OutlineApiError(endpoint, 0, String(error));
		}

		if (response.status >= 400) {
			const message =
				(response.json as { message?: string; error?: string } | undefined)?.message ??
				(response.json as { error?: string } | undefined)?.error ??
				response.text.slice(0, 200);
			throw new OutlineApiError(endpoint, response.status, message);
		}
		return response.json as T;
	}

	/** Verifies the token and returns the authenticated user's name. */
	async whoami(): Promise<{ name: string; email: string; isAdmin: boolean }> {
		const result = await this.post<{ data: { user: { name: string; email: string; role: string } } }>(
			"auth.info",
			{},
		);
		return {
			name: result.data.user.name,
			email: result.data.user.email,
			isAdmin: result.data.user.role === "admin",
		};
	}

	async listCollections(): Promise<OutlineCollection[]> {
		const collections: OutlineCollection[] = [];
		for (let offset = 0; ; offset += 100) {
			const page = await this.post<ListResponse<OutlineCollection & { archivedAt?: string | null }>>(
				"collections.list",
				{ limit: 100, offset },
			);
			collections.push(
				...page.data
					.filter((c) => !c.archivedAt)
					.map((c) => ({ id: c.id, urlId: c.urlId, name: c.name })),
			);
			if (page.data.length < 100) break;
		}
		return collections;
	}

	/**
	 * Every document in a collection, including its text and revision.
	 *
	 * documents.list carries both, so a full remote snapshot costs one
	 * request per 100 documents rather than one per document.
	 */
	async listDocuments(collectionId: string): Promise<RemoteDocument[]> {
		const documents: RemoteDocument[] = [];
		for (let offset = 0; ; offset += 100) {
			// NB: `sort: "index"` returns ONLY root-level documents — nested
			// children are omitted, which makes the sync think they were deleted
			// and trash the local notes. Use the default sort, which returns the
			// whole collection (nesting is rebuilt from parentDocumentId anyway).
			const page = await this.post<ListResponse<RawDocument>>("documents.list", {
				collectionId,
				limit: 100,
				offset,
			});
			documents.push(...page.data.filter((d) => !d.archivedAt && !d.deletedAt).map(toRemote));
			if (page.data.length < 100) break;
		}
		return documents;
	}

	async getDocument(id: string): Promise<RemoteDocument | undefined> {
		try {
			const result = await this.post<{ data: RawDocument }>("documents.info", { id });
			// A deleted document stays readable from Outline's trash (and an
			// archived one from the archive); for syncing, both are gone.
			if (result.data.deletedAt || result.data.archivedAt) return undefined;
			return toRemote(result.data);
		} catch (error) {
			if (error instanceof OutlineApiError && error.status === 404) return undefined;
			throw error;
		}
	}

	async updateDocument(params: {
		id: string;
		title?: string;
		text?: string;
	}): Promise<RemoteDocument> {
		const result = await this.post<{ data: RawDocument }>("documents.update", params);
		return toRemote(result.data);
	}

	async createDocument(params: {
		title: string;
		text: string;
		collectionId: string;
		parentDocumentId?: string;
		publish?: boolean;
	}): Promise<RemoteDocument> {
		const result = await this.post<{ data: RawDocument }>("documents.create", {
			publish: true,
			...params,
		});
		return toRemote(result.data);
	}

	async deleteDocument(id: string): Promise<void> {
		await this.post("documents.delete", { id });
	}

	/** Re-parents a document (moves it to a different folder/nesting in Outline). */
	async moveDocument(params: { id: string; collectionId: string; parentDocumentId?: string }): Promise<void> {
		await this.post("documents.move", {
			id: params.id,
			collectionId: params.collectionId,
			...(params.parentDocumentId ? { parentDocumentId: params.parentDocumentId } : {}),
		});
	}

	async createAttachment(params: {
		name: string;
		contentType: string;
		size: number;
		documentId?: string;
	}): Promise<AttachmentUpload> {
		const result = await this.post<{ data: AttachmentUpload }>("attachments.create", params);
		return result.data;
	}

	/** Downloads an attachment's bytes, following Outline's redirect. */
	async downloadAttachment(attachmentId: string): Promise<{ data: ArrayBuffer; contentType: string }> {
		const response = await requestUrl({
			url: `${this.apiUrl}/attachments.redirect?id=${encodeURIComponent(attachmentId)}`,
			method: "GET",
			headers: { Authorization: `Bearer ${this.token}` },
			throw: false,
		});
		if (response.status >= 400) {
			throw new OutlineApiError("attachments.redirect", response.status, response.text.slice(0, 200));
		}
		return {
			data: response.arrayBuffer,
			contentType: response.headers["content-type"] ?? "application/octet-stream",
		};
	}

	/**
	 * Uploads bytes to the pre-signed target from createAttachment.
	 *
	 * The bearer header is sent only for same-origin targets: Outline's
	 * local file storage needs it, while an S3 pre-signed POST rejects
	 * the request if an unexpected Authorization header is present.
	 */
	async uploadAttachmentData(
		upload: AttachmentUpload,
		data: ArrayBuffer,
		filename: string,
		contentType: string,
	): Promise<void> {
		const url = upload.uploadUrl.startsWith("http")
			? upload.uploadUrl
			: `${this.origin}${upload.uploadUrl}`;
		const { body, boundary } = buildMultipartBody(upload.form, data, filename, contentType);
		const headers: Record<string, string> = {
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
		};
		if (url.startsWith(this.origin)) {
			headers.Authorization = `Bearer ${this.token}`;
		}

		const response = await requestUrl({ url, method: "POST", headers, body, throw: false });
		if (response.status >= 400) {
			throw new OutlineApiError("attachment upload", response.status, response.text.slice(0, 200));
		}
	}
}

interface RawDocument {
	id: string;
	urlId: string;
	title: string;
	text: string;
	revision: number;
	updatedAt: string;
	collectionId: string;
	parentDocumentId?: string | null;
	archivedAt?: string | null;
	deletedAt?: string | null;
	updatedBy?: { id: string; name: string };
}

function toRemote(raw: RawDocument): RemoteDocument {
	return {
		id: raw.id,
		urlId: raw.urlId,
		title: raw.title,
		text: raw.text ?? "",
		revision: raw.revision ?? 0,
		updatedAt: raw.updatedAt,
		collectionId: raw.collectionId,
		parentDocumentId: raw.parentDocumentId ?? undefined,
		updatedBy: raw.updatedBy,
	};
}

/** Assembles a multipart/form-data body as bytes; requestUrl takes no FormData. */
function buildMultipartBody(
	fields: Record<string, string>,
	file: ArrayBuffer,
	filename: string,
	contentType: string,
): { body: ArrayBuffer; boundary: string } {
	const boundary = `----ObsidianOutline${Math.random().toString(36).slice(2)}`;
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];

	for (const [name, value] of Object.entries(fields ?? {})) {
		parts.push(
			encoder.encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
			),
		);
	}
	parts.push(
		encoder.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
				`Content-Type: ${contentType}\r\n\r\n`,
		),
	);
	parts.push(new Uint8Array(file));
	parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		body.set(part, offset);
		offset += part.length;
	}
	return { body: body.buffer, boundary };
}
