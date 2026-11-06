/** The `declare_delegation` record (senpi#5632): its principal and granted classes, parsed at the boundary. */
import type { RpcMethodClass } from "./method-classes.ts";

const FORWARDABLE_CLASSES: ReadonlySet<string> = new Set<Exclude<RpcMethodClass, "connection_local">>([
	"observe",
	"drive",
	"answer",
	"thread",
	"device_admin",
]);
const MAX_PRINCIPAL_FIELD = 256;
const MAX_CONN_FIELD = 64;

export interface Principal {
	readonly deviceId: string;
	readonly deviceName?: string;
	readonly conn?: string;
}

export function parseDeclaration(
	record: object,
): { readonly principal: Principal; readonly granted: ReadonlySet<RpcMethodClass> } | string {
	const principal: unknown = Reflect.get(record, "principal");
	if (typeof principal !== "object" || principal === null || Array.isArray(principal))
		return "principal must be an object";
	const deviceId: unknown = Reflect.get(principal, "deviceId");
	const deviceName: unknown = Reflect.get(principal, "deviceName");
	const conn: unknown = Reflect.get(principal, "conn");
	if (!boundedString(deviceId, MAX_PRINCIPAL_FIELD)) return "principal.deviceId must be 1-256 characters";
	if (deviceName !== undefined && !boundedString(deviceName, MAX_PRINCIPAL_FIELD))
		return "principal.deviceName must be 1-256 characters";
	if (conn !== undefined && !boundedString(conn, MAX_CONN_FIELD)) return "principal.conn must be 1-64 characters";
	const granted: unknown = Reflect.get(record, "granted");
	if (!Array.isArray(granted)) return "granted must be an array of method classes";
	const classes = new Set<RpcMethodClass>();
	for (const entry of granted) {
		if (typeof entry !== "string" || !FORWARDABLE_CLASSES.has(entry) || classes.has(entry as RpcMethodClass))
			return "granted holds each of observe, drive, answer, thread, device_admin at most once";
		classes.add(entry as RpcMethodClass);
	}
	return {
		principal: {
			deviceId: deviceId as string,
			...(deviceName === undefined ? {} : { deviceName: deviceName as string }),
			...(conn === undefined ? {} : { conn: conn as string }),
		},
		granted: classes,
	};
}

export function samePrincipal(a: Principal, b: Principal): boolean {
	return a.deviceId === b.deviceId && a.deviceName === b.deviceName && a.conn === b.conn;
}

function boundedString(value: unknown, max: number): boolean {
	return typeof value === "string" && value.length >= 1 && value.length <= max;
}
