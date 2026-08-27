import type { InterpreterAvailability } from "../interpreters/detect.ts";
import type { EvalLanguage, EvalRuntimeInfo, EvalRuntimes } from "../tool/types.ts";

export interface JsRuntimeVersions {
	readonly node: string;
	readonly bun?: string | undefined;
}

/** Identity of the in-process JS kernel host: bun when its marker exists, node otherwise. */
export function jsRuntimeInfo(
	versions: JsRuntimeVersions = process.versions,
	execPath: string = process.execPath,
): EvalRuntimeInfo {
	const bun = versions.bun;
	if (bun !== undefined && bun.length > 0) return { name: "bun", version: bun, path: execPath };
	return { name: "node", version: versions.node, path: execPath };
}

/** Short host-line segment, e.g. "node 26.7.0" or "bun 1.4.0". */
export function jsRuntimeLabel(versions: JsRuntimeVersions = process.versions): string {
	const info = jsRuntimeInfo(versions, "");
	return `${info.name} ${info.version}`;
}

const subprocessRuntimeNames = { py: "python", rb: "ruby", jl: "julia" } as const;
const subprocessLanguages = ["py", "rb", "jl"] as const;

/** Maps detected interpreters to display runtimes, preferring resolved absolute paths. */
export function runtimesFromAvailability(availability: InterpreterAvailability, js: EvalRuntimeInfo): EvalRuntimes {
	const runtimes: Partial<Record<EvalLanguage, EvalRuntimeInfo>> = { js };
	for (const language of subprocessLanguages) {
		const detected = availability[language].detected;
		if (!detected.ok) continue;
		runtimes[language] = {
			name: subprocessRuntimeNames[language],
			version: detected.version,
			path: detected.resolvedPath ?? detected.path,
		};
	}
	return runtimes;
}
