export interface CellRule {
	readonly permission: string;
	readonly pattern: string;
	readonly layer: string;
}
export interface CellCanonicalPath {
	/** PATH_IDENTITY_VERSION of the kernel that computed it; the host ignores any other version. */
	readonly v: number;
	readonly path: string;
	readonly foldCase: boolean;
}
export type CellOperation = {
	readonly tool: "bash" | "read" | "write" | "ls";
	readonly input: {
		readonly command?: string;
		/** The path as written by the cell, byte-for-byte. */
		readonly path?: string;
		/** The absolute string the operation hands to the runtime. */
		readonly executedPath?: string;
		readonly canonical?: CellCanonicalPath;
		/** Error code when the kernel could not canonicalize the executed path. */
		readonly unresolvable?: string;
	};
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
		deadlineMs?: number;
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
