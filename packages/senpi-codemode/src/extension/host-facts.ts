import * as os from "node:os";
import { jsRuntimeLabel } from "./runtime-info.ts";

/** The one-line host description the eval prompt shows (platform, CPU, cores, JS runtime). */
export function hostLine(): string {
	const cpu = os.cpus()[0]?.model?.trim();
	return [`${os.platform()} ${os.arch()}`, cpu, `${os.availableParallelism()} cores`, jsRuntimeLabel()]
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
