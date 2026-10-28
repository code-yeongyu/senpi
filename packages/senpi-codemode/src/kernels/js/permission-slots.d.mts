export interface CellRule {
	readonly permission: string;
	readonly pattern: string;
	readonly layer: string;
}
export type CellOperation = {
	readonly tool: "bash" | "write";
	readonly input: { readonly command?: string; readonly path?: string };
	readonly cwd?: string;
};
export type CellDecision = { readonly action: "pass" } | { readonly action: "deny"; readonly rule: CellRule };
export interface PermissionRequest {
	readonly token: string;
	readonly call: CellOperation;
}
export function createPermissionSlots(): SharedArrayBuffer;
export function permissionControl(buffer: SharedArrayBuffer, index: number): number;
export function interruptPermissionSlot(buffer: SharedArrayBuffer, index: number, observed: number): boolean;
export function interruptPermissionSlots(buffer: SharedArrayBuffer): void;
export function createPermissionRequester(
	buffer: SharedArrayBuffer,
	hooks: {
		wake(index: number, generation: number): void;
		wait?: typeof Atomics.wait;
		generationLimit?: number;
		retire?(): void;
	},
): { check(request: PermissionRequest): CellDecision };
export function servePermissionSlot(
	buffer: SharedArrayBuffer,
	index: number,
	generation: number,
	decide: (request: PermissionRequest) => CellDecision | Promise<CellDecision>,
	hooks?: { claimed?(): void | Promise<void> },
): Promise<void>;
