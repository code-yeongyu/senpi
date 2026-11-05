import { dirname } from "node:path";

export const APPROVED_MONITOR_PARENT = Symbol("approved-monitor-parent");

export type MonitorPermissionInput = Record<string, unknown> & {
	[APPROVED_MONITOR_PARENT]?: string;
};

export function setApprovedMonitorParent(input: Record<string, unknown>, parent: string): void {
	Object.defineProperty(input, APPROVED_MONITOR_PARENT, {
		configurable: true,
		value: parent,
		writable: false,
	});
}

export function getApprovedMonitorParent(input: Record<string, unknown>): string | undefined {
	return (input as MonitorPermissionInput)[APPROVED_MONITOR_PARENT];
}

/**
 * Carry the parent the permission parser approved onto the frozen copy of a monitor call (senpi#5795): the JSON freeze
 * drops symbol keys, which would skip the parent-swap check at registration. Only for the same watched path; never
 * throws.
 */
export function transferApprovedMonitorParent(from: unknown, to: unknown): void {
	if (typeof from !== "object" || from === null || typeof to !== "object" || to === null) return;
	const source = from as Record<string, unknown>;
	const target = to as Record<string, unknown>;
	const parent = getApprovedMonitorParent(source);
	if (parent === undefined || source.path !== target.path) return;
	setApprovedMonitorParent(target, parent);
}

export function monitorParent(path: string): string {
	return dirname(path);
}
