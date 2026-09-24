import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { EntryRenderer, EntryRendererOptions } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";

/**
 * Component that renders a custom session entry from extensions.
 * The host owns transcript spacing; renderer output should provide only its content.
 */
export class CustomEntryComponent extends Container {
	private entry: CustomEntry<unknown>;
	private renderer: EntryRenderer;
	private customComponent?: Component;
	private _expanded = false;

	constructor(entry: CustomEntry<unknown>, renderer: EntryRenderer) {
		super();
		this.entry = entry;
		this.renderer = renderer;
		this.rebuild();
	}

	get customEntry(): CustomEntry<unknown> {
		return this.entry;
	}

	hasContent(): boolean {
		return this.customComponent !== undefined;
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.customComponent = undefined;

		let component: Component | undefined;
		try {
			component = this.renderer(this.entry, { expanded: this._expanded }, theme);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(theme.fg("error", `[${this.entry.customType}] renderer failed: ${message}`), 0, 0));
			component = box;
		}

		if (!component) {
			return;
		}

		this.customComponent = component;
		this.addChild(new Spacer(1));
		this.addChild(component);
	}
}

/**
 * Index of the card `entry` replaces in place: the transcript card directly before
 * `insertIndex` (skipping only `isTransient` children such as a status line), when it
 * renders an entry of the same custom type and the renderer's `replaces` option accepts
 * the pair. Returns -1 when `entry` becomes a new card.
 */
export function replacedEntryCardIndex(
	children: readonly Component[],
	insertIndex: number,
	entry: CustomEntry<unknown>,
	options: EntryRendererOptions | undefined,
	isTransient: (child: Component) => boolean = () => false,
): number {
	if (options?.replaces === undefined) return -1;
	let previousIndex = insertIndex - 1;
	while (previousIndex >= 0 && isTransient(children[previousIndex] as Component)) previousIndex--;
	const previous = children[previousIndex];
	if (!(previous instanceof CustomEntryComponent)) return -1;
	if (previous.customEntry.customType !== entry.customType) return -1;
	return options.replaces(previous.customEntry, entry) ? previousIndex : -1;
}
