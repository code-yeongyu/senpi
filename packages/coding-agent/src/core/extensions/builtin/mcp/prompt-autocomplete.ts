// TUI `/` completion for MCP prompt commands that register after the editor's
// autocomplete snapshot (senpi#7249). Interactive mode copies the extension
// command list when it builds its provider, so a prompt from a later catalog
// generation would run but never be suggested. This wrapper adds the registrar's
// live prompt commands the snapshot lacks; anything the snapshot already has is
// left to it, so stacking the wrapper twice adds nothing twice.

import { type AutocompleteItem, type AutocompleteProvider, fuzzyFilter } from "@earendil-works/pi-tui";
import type { AutocompleteProviderFactory } from "../../types.ts";

export function mcpPromptAutocomplete(current: () => ReadonlyMap<string, string>): AutocompleteProviderFactory {
	return (base: AutocompleteProvider): AutocompleteProvider => ({
		triggerCharacters: base.triggerCharacters,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const suggestions = await base.getSuggestions(lines, cursorLine, cursorCol, options);
			const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const commandText = textBeforeCursor.trimStart();
			if (options.force || !commandText.startsWith("/") || commandText.includes(" ")) return suggestions;
			const known = new Set(suggestions?.items.map((item) => item.value));
			const missing: AutocompleteItem[] = [...current()]
				.filter(([name]) => !known.has(name))
				.map(([name, description]) => ({ value: name, label: name, description }));
			const extra = fuzzyFilter(missing, commandText.slice(1), (item) => item.value);
			if (extra.length === 0) return suggestions;
			return { items: [...(suggestions?.items ?? []), ...extra], prefix: suggestions?.prefix ?? commandText };
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			base.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
		shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
			base.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
		getMentionRanges: (line) => base.getMentionRanges?.(line) ?? [],
	});
}
