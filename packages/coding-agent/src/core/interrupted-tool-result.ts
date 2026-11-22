import type { AfterToolCallResult } from "@earendil-works/pi-agent-core";

export const INTERRUPTED_TOOL_TEXT =
	"Interrupted by the user's Stop before it finished. Its side effects may be partial. It was not re-run.";

export type StopInterrupt = { readonly pauseSeq: number; readonly at: string };

export function markInterrupted(
	stop: StopInterrupt | undefined,
	isError: boolean,
	details: unknown,
	override: AfterToolCallResult | undefined,
): AfterToolCallResult | undefined {
	if (stop === undefined || !isError) return override;
	const base = override?.details ?? details;
	const merged = typeof base === "object" && base !== null ? { ...base, interrupted: stop } : { interrupted: stop };
	return { ...override, details: merged, content: [{ type: "text", text: INTERRUPTED_TOOL_TEXT }] };
}
