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

export function monitorParent(path: string): string {
	return dirname(path);
}
