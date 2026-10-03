import { Modal, type App } from "obsidian";

/**
 * A popup holding the rest of a long settings list. `render` draws the rows;
 * `rerender()` redraws them in place after one changes, so a toggle flipped
 * here doesn't make its row jump away mid-interaction. Closed with the modal's ×.
 */
export class MoreModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly render: (container: HTMLElement, modal: MoreModal) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("outline-sync-more");
		this.rerender();
	}

	rerender(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h3", { text: this.heading });
		this.render(this.contentEl, this);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
