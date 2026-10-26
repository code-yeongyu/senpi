const warnedVariables = new Set<string>();

export function warnOpaqueConfigEnvironment(name: string, value: string | undefined): void {
	if (value !== undefined && /\{(?:file|env):/.test(value) && !warnedVariables.has(name)) {
		warnedVariables.add(name);
		console.warn(`${name}: environment value contains reference-looking text; inserted literally`);
	}
}

export function warnMissingConfigEnvironment(name: string): void {
	if (warnedVariables.has(name)) return;
	warnedVariables.add(name);
	console.warn(`${name}: configuration environment variable is unset`);
}
