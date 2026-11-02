import { join } from "node:path";
import executableSettings from "./executable-settings.json" with { type: "json" };
import type { CodemodeSettings } from "./settings.ts";

/**
 * Settings that name an executable run at session start (an interpreter's `--version` probe, then the kernel). The
 * one list of them lives in `executable-settings.json`, which senpi's project-trust check also reads: a project
 * codemode file that sets any of them asks for trust. Without trust they are dropped with a warning and never run.
 * Trust is asked only when the project's own file sets one, so a host that cannot answer still starts sessions;
 * such a host counts as not trusting the project.
 */
export const PROJECT_EXECUTABLE_SETTINGS: readonly string[] = executableSettings.projectExecutableSettings;

export function withoutUntrustedInterpreter<Settings extends CodemodeSettings>(
	settings: Settings,
	source: string | null,
	cwd: string,
	isProjectTrusted: (() => boolean) | undefined,
): { readonly settings: Settings; readonly warning?: string } {
	const projectFile = join(cwd, ".senpi", "codemode.json");
	if (source !== projectFile) return { settings };
	const named = PROJECT_EXECUTABLE_SETTINGS.filter((path) => valueAt(settings, path) !== undefined);
	if (named.length === 0 || isProjectTrusted?.() === true) return { settings };
	let trimmed: Settings = settings;
	for (const path of named) trimmed = withoutPath(trimmed, path);
	const list = named.map((path) => `${path} "${String(valueAt(settings, path))}"`).join(", ");
	return {
		settings: trimmed,
		warning: `${list} in ${projectFile} is ignored because this project is not trusted; it was not run`,
	};
}

function valueAt(value: unknown, path: string): unknown {
	let current: unknown = value;
	for (const key of path.split(".")) {
		if (typeof current !== "object" || current === null) return undefined;
		current = Reflect.get(current, key);
	}
	return current;
}

function withoutPath<T>(value: T, path: string): T {
	const copy = structuredClone(value);
	const keys = path.split(".");
	const last = keys.pop();
	let parent: unknown = copy;
	for (const key of keys)
		parent = typeof parent === "object" && parent !== null ? Reflect.get(parent, key) : undefined;
	if (last !== undefined && typeof parent === "object" && parent !== null) Reflect.deleteProperty(parent, last);
	return copy;
}
