import type { Component } from "./tui.ts";

export const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

export interface LayoutViewport {
	width: number;
	height: number;
}

/** A non-owning presentation entry whose key survives source reprojection. */
export interface ScrollEntry {
	readonly key: object;
	readonly component: Component;
	readonly sourceIndex: number;
	/** Undefined revisions are rendered afresh once per layout frame. */
	readonly revision?: number;
	readonly prompt?: boolean;
}

export interface ScrollEntrySource {
	readonly version: number;
	readonly displayRevision: number;
	readonly length: number;
	get(index: number): ScrollEntry;
	indexOf(key: object): number | undefined;
	resolve(key: object, sourceIndexHint: number): number | undefined;
	/** Earliest changed source index; Infinity for none, undefined when history is unavailable. */
	changedSince?(version: number): number | undefined;
}

/** Entry identity and an entry-local rendered row, independent of preceding heights. */
export interface ScrollEntryAnchor {
	readonly key: object;
	readonly sourceIndex: number;
	readonly row: number;
}

export interface ScrollEntryRender {
	readonly entry: ScrollEntry;
	readonly index: number;
	readonly lines: readonly string[];
}

export interface ScrollEntryPlacement extends ScrollEntryRender {
	/** Entry origin relative to the viewport; negative for a clipped first entry. */
	readonly top: number;
}

export interface ScrollEntryRow {
	readonly anchor: ScrollEntryAnchor;
	readonly line: string;
	readonly revision?: number;
}

/** A bounded viewport snapshot, never a sparse substitute for the whole document. */
export interface ScrollEntryFrame {
	readonly source: ScrollEntrySource;
	readonly width: number;
	readonly height: number;
	readonly version: number;
	readonly displayRevision: number;
	readonly pending: boolean;
	readonly entries: readonly ScrollEntryPlacement[];
	/** Exactly height slots; undefined slots contain no committed entry row. */
	readonly rows: readonly (ScrollEntryRow | undefined)[];
}

export interface StackLayoutEntry {
	component: Component;
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}

export interface StackLayoutNode {
	type: "vstack" | "hstack";
	entries: readonly StackLayoutEntry[];
	gap: number;
	align: "stretch" | "start" | "center" | "end";
}

export interface ScrollLayoutState {
	readonly scrollTop: number;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly viewportHeight: number;
	getContentWidth(width: number): number;
	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
}

export interface ScrollLayoutNode {
	type: "scroll";
	component: Component;
	state: ScrollLayoutState;
	entries?: ScrollEntrySource;
}

export type LayoutNode = StackLayoutNode | ScrollLayoutNode;

export interface LayoutComponent extends Component {
	[LAYOUT_NODE](): LayoutNode;
}

export function getLayoutNode(component: Component): LayoutNode | undefined {
	const candidate = component as Partial<LayoutComponent>;
	return typeof candidate[LAYOUT_NODE] === "function" ? candidate[LAYOUT_NODE]() : undefined;
}

/** Internal sizing distinction: indexed stack subtrees have bounded screen measurement but explicit full rendering. */
export function hasIndexedScroll(component: Component, viewport?: LayoutViewport): boolean {
	const node = getLayoutNode(component);
	if (!node) return false;
	if (node.type === "scroll") return node.entries !== undefined;
	return node.entries.some(
		(entry) =>
			(viewport === undefined || (entry.visible?.(viewport) ?? true)) && hasIndexedScroll(entry.component, viewport),
	);
}
