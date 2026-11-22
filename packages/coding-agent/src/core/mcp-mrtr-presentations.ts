import type { ExtensionUIContext } from "./extensions/types.ts";
import type { McpFormBinding } from "./mcp-form-types.ts";

/** Local host references only. RPC capabilities and serialized UI objects cannot enter this registry. */
export interface McpMrtrPresentation {
	readonly ui: Pick<ExtensionUIContext, "select" | "input">;
	readonly signal: AbortSignal;
	readonly admit?: () => void;
	readonly presented?: () => void;
	readonly privateForms?: McpFormBinding;
}
const presentations = new WeakMap<object, McpMrtrPresentation>();
const presentationChanges = new Set<() => void>();

/**
 * Runs `listener` whenever a host registers or rebinds a presentation (a new private-form epoch), so a readiness
 * subscription can follow the current binding instead of the one it first saw (senpi#4245).
 */
export function onMcpMrtrPresentationChange(listener: () => void): () => void {
	presentationChanges.add(listener);
	return () => {
		presentationChanges.delete(listener);
	};
}

export function notifyMcpMrtrPresentationChange(): void {
	for (const listener of [...presentationChanges]) listener();
}

export function registerMcpMrtrPresentation(
	ui: ExtensionUIContext,
	signal: AbortSignal,
	admit?: () => void,
	privateForms?: McpFormBinding,
): ExtensionUIContext {
	presentations.set(ui, { ui, signal, admit, privateForms });
	notifyMcpMrtrPresentationChange();
	return ui;
}

export function getMcpMrtrPresentation(ui: object): McpMrtrPresentation | undefined {
	const presentation = presentations.get(ui);
	return presentation?.signal.aborted ? undefined : presentation;
}

/** Preserve host identity across runner wrapping; private dialogs still use the raw host UI. */
export function inheritMcpMrtrPresentation(
	source: ExtensionUIContext,
	wrapper: ExtensionUIContext,
): ExtensionUIContext {
	const presentation = getMcpMrtrPresentation(source);
	if (presentation) presentations.set(wrapper, presentation);
	return wrapper;
}
