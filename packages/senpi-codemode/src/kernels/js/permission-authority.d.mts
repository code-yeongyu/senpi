export interface WireAuthority {
	readonly id: string;
	readonly authority: SharedArrayBuffer;
	readonly rules: readonly import("./permission-slots.mjs").CellRule[];
}
export function authorityDecision(
	current: WireAuthority | undefined,
	bound: readonly WireAuthority[],
	kernel: WireAuthority,
): "pass" | "check" | "refuse";
