/**
 * Environment names as the target platform's C runtime sees them. POSIX names are case-sensitive,
 * so `node_extra_ca_certs` is another variable. Windows `getenv` is case-insensitive, while Bun's
 * `process.env` keeps the user's casing and `Bun.spawn` copies every key as given, so a child can
 * hold two case forms of one name and its CRT decides which one Bun loads.
 */
export type EnvironmentEntries = Readonly<Record<string, string | undefined>>;

function caseFormsOf(env: EnvironmentEntries, name: string, platform: NodeJS.Platform): string[] {
	if (platform !== "win32") return name in env ? [name] : [];
	const upper = name.toUpperCase();
	return Object.keys(env).filter((key) => key.toUpperCase() === upper);
}

export function hasName(env: EnvironmentEntries, name: string, platform: NodeJS.Platform): boolean {
	return caseFormsOf(env, name, platform).some((key) => env[key] !== undefined);
}

/** Every distinct defined value the name carries; more than one means the CRT, not us, picks. */
export function valuesOf(env: EnvironmentEntries, name: string, platform: NodeJS.Platform): string[] {
	const values = caseFormsOf(env, name, platform)
		.map((key) => env[key])
		.filter((value): value is string => value !== undefined);
	return [...new Set(values)];
}

export function deleteName(env: Record<string, string | undefined>, name: string, platform: NodeJS.Platform): void {
	for (const key of caseFormsOf(env, name, platform)) delete env[key];
}

export function setName(
	env: Record<string, string | undefined>,
	name: string,
	value: string,
	platform: NodeJS.Platform,
): void {
	deleteName(env, name, platform);
	env[name] = value;
}
