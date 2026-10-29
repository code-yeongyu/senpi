import * as os from "node:os";
import { jsRuntimeLabel } from "./runtime-info.ts";

/**
 * Test-only host pin (senpi#4660): the same `SENPI_TEST_WORKSTATION={"cpuModel":string,"cores":int,"kernel":string}`
 * coding-agent's workstation.ts reads. Its CPU model and core count replace the real ones in the `Host:` line, so a
 * harness driving the real CLI gets the same prompt bytes on every host. Unset (or empty) in every production launch.
 */
const WORKSTATION_ENV = "SENPI_TEST_WORKSTATION";

function pinnedCpu(env: NodeJS.ProcessEnv): { readonly cpuModel: string; readonly cores: number } | undefined {
	const value = env[WORKSTATION_ENV];
	if (value === undefined || value === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		parsed = undefined;
	}
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		!Array.isArray(parsed) &&
		Object.keys(parsed).sort().join(",") === "cores,cpuModel,kernel" &&
		"cpuModel" in parsed &&
		"cores" in parsed &&
		"kernel" in parsed
	) {
		const { cpuModel, cores, kernel } = parsed;
		if (
			typeof cpuModel === "string" &&
			cpuModel !== "" &&
			typeof kernel === "string" &&
			kernel !== "" &&
			typeof cores === "number" &&
			Number.isInteger(cores) &&
			cores >= 1
		)
			return { cpuModel, cores };
	}
	throw new Error(
		`${WORKSTATION_ENV} must be a JSON object {"cpuModel": non-empty string, "cores": positive integer, "kernel": non-empty string}, got ${JSON.stringify(value)}`,
	);
}

/** The one-line host description the eval prompt shows (platform, CPU, cores, JS runtime). */
export function hostLine(env: NodeJS.ProcessEnv = process.env): string {
	const pinned = pinnedCpu(env);
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
