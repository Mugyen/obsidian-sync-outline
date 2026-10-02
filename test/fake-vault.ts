/* An in-memory vault good enough to drive the sync engine. */
import { TFile } from "obsidian";

export class FakeVault {
	readonly files = new Map<string, string>();
	readonly binaries = new Map<string, ArrayBuffer>();
	readonly folders = new Set<string>();
	readonly trashed: string[] = [];
	private mtimes = new Map<string, number>();

	seed(path: string, content: string, mtime = Date.now()): void {
		this.files.set(path, content);
		this.mtimes.set(path, mtime);
	}

	private handle(path: string): TFile {
		const file = new TFile();
		file.path = path;
		file.name = path.split("/").pop() ?? path;
		file.basename = file.name.replace(/\.[^.]+$/, "");
		file.extension = file.name.includes(".") ? (file.name.split(".").pop() as string) : "";
		const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
		file.parent = { path: parentPath };
		file.stat = { mtime: this.mtimes.get(path) ?? 0, ctime: 0, size: (this.files.get(path) ?? "").length };
		return file;
	}

	getMarkdownFiles(): TFile[] {
		return [...this.files.keys()].filter((path) => path.endsWith(".md")).map((path) => this.handle(path));
	}
	getFiles(): TFile[] {
		return [...this.files.keys(), ...this.binaries.keys()].map((path) => this.handle(path));
	}
	getFileByPath(path: string): TFile | null {
		return this.files.has(path) || this.binaries.has(path) ? this.handle(path) : null;
	}
	getAbstractFileByPath(path: string): TFile | { path: string } | null {
		if (this.folders.has(path)) return { path };
		// Like a real vault, a folder exists while anything lives inside it.
		const inside = (key: string) => key.startsWith(`${path}/`);
		if ([...this.files.keys(), ...this.binaries.keys()].some(inside)) return { path };
		return this.getFileByPath(path);
	}
	async read(file: TFile): Promise<string> {
		return this.files.get(file.path) ?? "";
	}
	async readBinary(file: TFile): Promise<ArrayBuffer> {
		return this.binaries.get(file.path) ?? new ArrayBuffer(0);
	}
	async modify(file: TFile, data: string): Promise<void> {
		this.files.set(file.path, data);
		this.mtimes.set(file.path, Date.now());
	}
	async create(path: string, data: string): Promise<TFile> {
		this.files.set(path, data);
		this.mtimes.set(path, Date.now());
		return this.handle(path);
	}
	async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		this.binaries.set(path, data);
		return this.handle(path);
	}
	async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
		this.binaries.set(file.path, data);
	}
	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}
}

export class FakeApp {
	readonly vault = new FakeVault();
	readonly fileManager = {
		renameFile: async (file: TFile | { path: string }, newPath: string): Promise<void> => {
			const from = file.path;
			const move = (key: string) => (key === from ? newPath : key.startsWith(`${from}/`) ? newPath + key.slice(from.length) : undefined);
			// Works for a single file and for a folder with everything inside it.
			for (const store of [this.vault.files, this.vault.binaries] as Map<string, unknown>[]) {
				for (const [key, value] of [...store]) {
					const target = move(key);
					if (target === undefined) continue;
					store.delete(key);
					store.set(target, value);
				}
			}
			for (const folder of [...this.vault.folders]) {
				const target = move(folder);
				if (target === undefined) continue;
				this.vault.folders.delete(folder);
				this.vault.folders.add(target);
			}
		},
		trashFile: async (file: TFile): Promise<void> => {
			this.vault.files.delete(file.path);
			this.vault.binaries.delete(file.path);
			this.vault.trashed.push(file.path);
		},
	};
	readonly metadataCache = {
		getFirstLinkpathDest: (target: string): TFile | null => this.vault.getFileByPath(target),
	};
}
