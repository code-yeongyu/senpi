import type { BuiltinExtensionFactory } from "./extensions/builtin/index.ts";

export interface BuiltinSelection {
	/** `enabledBuiltinExtensions`: when set, only these ids load. */
	readonly enabled?: readonly string[];
	/** `disabledBuiltinExtensions`. */
	readonly disabled: readonly string[];
}

/**
 * The internal builtins the given selected ids require, in registry order. An internal builtin is never matched
 * against the user's allowlist or denylist: it loads exactly when something selected needs it (senpi#1146).
 */
export function requiredInternalBuiltins(
	registry: readonly BuiltinExtensionFactory[],
	selectedIds: ReadonlySet<string>,
): BuiltinExtensionFactory[] {
	const required = new Set(
		registry.filter((builtin) => selectedIds.has(builtin.id)).flatMap((builtin) => builtin.requires ?? []),
	);
	return registry.filter((builtin) => builtin.internal && required.has(builtin.id));
}

/** Ids of the registry and bundled builtins to load for this selection, internal dependencies included. */
export function selectActiveBuiltinIds(
	registry: readonly BuiltinExtensionFactory[],
	bundledIds: readonly string[],
	selection: BuiltinSelection,
): Set<string> {
	const enabled = selection.enabled ? new Set(selection.enabled) : undefined;
	const disabled = new Set(selection.disabled);
	const selectable = (id: string) => (!enabled || enabled.has(id)) && !disabled.has(id);
	const active = new Set(
		registry.filter((builtin) => !builtin.internal && selectable(builtin.id)).map((builtin) => builtin.id),
	);
	for (const builtin of requiredInternalBuiltins(registry, active)) active.add(builtin.id);
	for (const id of bundledIds) if (selectable(id)) active.add(id);
	return active;
}
