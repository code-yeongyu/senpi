import type { ExtensionPlacement, ExtensionSide } from "./types.ts";

function assertNever(value: never): never {
	throw new Error(`unknown extension placement: ${String(value)}`);
}

/**
 * Whether a generation at `placement` registers a handler declared `runs`. Only a split-local hand leaves a side to
 * another process (its loop runs the `"brain"` handlers); a hosted hand is its extensions' home, so the loop's events
 * come to it and it registers both sides, as a fused session does.
 */
export function registersSide(placement: ExtensionPlacement, runs: ExtensionSide): boolean {
	switch (placement) {
		case "fused":
		case "hosted-hand":
			return true;
		case "hand":
			return runs === "hand";
		default:
			return assertNever(placement);
	}
}
