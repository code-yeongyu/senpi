import * as os from "node:os";
import * as path from "node:path";
import { jsRuntimeLabel } from "./runtime-info.ts";

/**
 * Test-only host pin (senpi#4660): the same `SENPI_TEST_WORKSTATION={"cpuModel":string,"cores":int,"kernel":string}`
 * coding-agent's workstation.ts reads. Its CPU model and core count replace the real ones in the `Host:` line, so a
 * harness driving the real CLI gets the same prompt bytes on every host. Its optional
 * `"repoRoot":{"from":absolute path,"to":absolute path}` (senpi#5067) shows a path under the checkout `from` under `to`
 * where the eval prompt renders it (`pinnedDisplayPath`). Unset (or empty) in every production launch.
 */
const WORKSTATION_ENV = "SENPI_TEST_WORKSTATION";

interface PinnedWorkstation {
	readonly cpuModel: string;
	readonly cores: number;
	readonly repoRoot?: { readonly from: string; readonly to: string };
}

function pinnedRepoRoot(value: unknown): { readonly from: string; readonly to: string } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if (Object.keys(value).sort().join(",") !== "from,to" || !("from" in value) || !("to" in value)) return undefined;
	const { from, to } = value;
	if (typeof from !== "string" || typeof to !== "string" || !path.isAbsolute(from) || !path.isAbsolute(to))
		return undefined;
	return { from, to };
}

function pinnedWorkstation(env: NodeJS.ProcessEnv): PinnedWorkstation | undefined {
	const value = env[WORKSTATION_ENV];
	if (value === undefined || value === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		parsed = undefined;
	}
	const keys = typeof parsed === "object" && parsed !== null ? Object.keys(parsed).sort().join(",") : "";
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		!Array.isArray(parsed) &&
		(keys === "cores,cpuModel,kernel" || keys === "cores,cpuModel,kernel,repoRoot") &&
		"cpuModel" in parsed &&
		"cores" in parsed &&
		"kernel" in parsed
	) {
		const { cpuModel, cores, kernel } = parsed;
		const repoRoot = "repoRoot" in parsed ? pinnedRepoRoot(parsed.repoRoot) : undefined;
		if (
			!("repoRoot" in parsed && repoRoot === undefined) &&
			typeof cpuModel === "string" &&
			cpuModel !== "" &&
			typeof kernel === "string" &&
			kernel !== "" &&
			typeof cores === "number" &&
			Number.isInteger(cores) &&
			cores >= 1
		)
			return { cpuModel, cores, ...(repoRoot === undefined ? {} : { repoRoot }) };
	}
	throw new Error(
		`${WORKSTATION_ENV} must be a JSON object {"cpuModel": non-empty string, "cores": positive integer, "kernel": non-empty string, optional "repoRoot": {"from": absolute path, "to": absolute path}}, got ${JSON.stringify(value)}`,
	);
}

/**
 * `filePath` as the eval prompt should show it: under the test-only `repoRoot` pin, a path inside the pinned checkout
 * (`from`) is shown under `to`. Every other path, and every path when the pin is unset, is returned unchanged.
 * Only for rendering: reads keep using the real path.
 */
export function pinnedDisplayPath(filePath: string, env: NodeJS.ProcessEnv = process.env): string {
	const root = pinnedWorkstation(env)?.repoRoot;
	if (root === undefined) return filePath;
	if (filePath === root.from) return root.to;
	const prefix = root.from.endsWith(path.sep) ? root.from : root.from + path.sep;
	return filePath.startsWith(prefix) ? path.join(root.to, filePath.slice(prefix.length)) : filePath;
}

/** The one-line host description the eval prompt shows (platform, CPU, cores, JS runtime). */
export function hostLine(env: NodeJS.ProcessEnv = process.env): string {
	const pinned = pinnedWorkstation(env);
	const cpu = pinned ? pinned.cpuModel : os.cpus()[0]?.model?.trim();
	const cores = pinned ? pinned.cores : os.availableParallelism();
	return [`${os.platform()} ${os.arch()}`, cpu, `${cores} cores`, jsRuntimeLabel()]
		.filter((part): part is string => !!part)
		.join(" \u00b7 ");
}

/** The model id carried by a `model_select` event, when it has one. */
export function modelIdFrom(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null || !("model" in event)) return undefined;
	const model = event.model;
	if (typeof model !== "object" || model === null || !("id" in model)) return undefined;
	return typeof model.id === "string" ? model.id : undefined;
}
