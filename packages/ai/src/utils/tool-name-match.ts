/**
 * Lenient tool-name matching shared by the inbound tool-call resolver
 * (`@earendil-works/pi-agent-core` `resolveToolNameAlias`) and the Anthropic
 * tool-reference repair, so both paths accept the same shapes.
 *
 * Models write tool names in shapes no tool was registered under: recased
 * (`LazyWeather` for `lazy_weather`), under a gateway namespace in any case
 * (`mcp__686f__Eval`, `MCP__686f__Eval`), under a namespace whose id contains
 * underscores (`mcp__my_server__Memory`), or without the `mcp_<server>_`
 * prefix senpi's own MCP tools carry (`create_issue` for
 * `mcp_github_create_issue`).
 *
 * A namespace is cut only at its delimiter: `__` for the gateway form, the
 * first `_` for `mcp_<server>_<tool>`. It is never cut inside the tool's own
 * name, so `mcp__sandbox__run_bash` cannot fall through to a local `bash`.
 * Each form is tried most specific first (exact, case/separator fold, then a
 * registered tool whose unprefixed name folds the same), and a step resolves
 * only when exactly one tool matches it: the matcher never guesses between two
 * candidates.
 */

const GATEWAY_NAMESPACE = /^mcp__(.+)$/i;
const GATEWAY_DELIMITER = /_{2,}/g;
const SERVER_NAMESPACE = /^mcp_([^_]+)_(.+)$/i;

export function foldToolName(name: string): string {
	return name.toLowerCase().replaceAll(/[-_]/g, "");
}

/**
 * The name itself, then its unprefixed remainders, longest first:
 * `mcp__my_srv__x__Tool` -> `x__Tool`, `Tool`; `mcp_github_create_issue` ->
 * `create_issue`.
 */
export function toolNameForms(name: string): string[] {
	const forms = [name];
	const gateway = GATEWAY_NAMESPACE.exec(name);
	if (gateway) {
		const rest = gateway[1] ?? "";
		for (const run of rest.matchAll(GATEWAY_DELIMITER)) {
			const suffix = rest.slice(run.index + run[0].length);
			if (run.index > 0 && suffix.length > 0) forms.push(suffix);
		}
		return forms;
	}
	const tool = SERVER_NAMESPACE.exec(name)?.[2];
	if (tool !== undefined) forms.push(tool);
	return forms;
}

function uniqueMatch(names: readonly string[], matches: (name: string) => boolean): string | undefined {
	const found = names.filter(matches);
	return found.length === 1 ? found[0] : undefined;
}

/** Resolve `requested` to the one available tool it names, or `undefined` when none or several match. */
export function resolveToolNameMatch(requested: string, available: Iterable<string>): string | undefined {
	const names = [...new Set(available)];
	for (const form of toolNameForms(requested)) {
		if (names.includes(form)) return form;
		const key = foldToolName(form);
		const folded = uniqueMatch(names, (name) => foldToolName(name) === key);
		if (folded !== undefined) return folded;
		const unprefixed = uniqueMatch(names, (name) =>
			toolNameForms(name)
				.slice(1)
				.some((registeredForm) => foldToolName(registeredForm) === key),
		);
		if (unprefixed !== undefined) return unprefixed;
	}
	return undefined;
}
