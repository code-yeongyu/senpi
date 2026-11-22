import { APP_NAME } from "../config.ts";
import type { IdleHandoverTerms } from "../modes/rpc/host-handover-request.ts";

/** The conditional handover's terms: all five flags together, or a usage error naming what is wrong. */
export function handoverTerms(flags: Readonly<Record<string, string>>): IdleHandoverTerms | string {
	const when = flags["--when"];
	const operationId = flags["--operation"];
	const ifInstanceId = flags["--if-instance"];
	const generation = flags["--if-generation"];
	const targetRuntimeBuildId = flags["--target-build"];
	if (when !== "idle") return `Error: "${APP_NAME} host handoff" supports only --when idle.`;
	if (!operationId || !ifInstanceId || !generation || !targetRuntimeBuildId) {
		return `Error: "${APP_NAME} host handoff --when idle" needs --operation, --if-instance, --if-generation and --target-build.`;
	}
	const ifGeneration = Number(generation);
	if (!/^\d+$/.test(generation) || !Number.isSafeInteger(ifGeneration)) {
		return `Error: --if-generation must be a non-negative integer.`;
	}
	return { operationId, ifInstanceId, ifGeneration, targetRuntimeBuildId };
}
