/**
 * The remote device a connection speaks for (senpi#5475, omo-relay-daemon#184 P5).
 *
 * A relay forwarder opens one engine connection per remote sender and declares, through its own
 * `set_client_info`, which device that connection speaks for. Every dialog a command of that connection raises
 * then carries the value as `remoteOrigin`, so the host's desktop and TUI can label it "Requested from <device>".
 * A connection that never declared one is local, and its dialogs carry no `remoteOrigin`. The engine copies only
 * this declared value, never a free-form client name. `set_client_info` is `connection_local` in the method-class
 * table, so a forwarded record can never set or change it.
 */

export interface RpcRemoteOrigin {
	readonly deviceId: string;
	readonly deviceName?: string;
}

const MAX_DEVICE_ID_CHARACTERS = 256;
const MAX_DEVICE_NAME_CHARACTERS = 256;

export const REMOTE_ORIGIN_INVALID =
	"remote_origin_invalid: remoteOrigin must be { deviceId: non-empty string, deviceName?: non-empty string }";
export const REMOTE_ORIGIN_FIXED =
	"remote_origin_fixed: a connection's remoteOrigin cannot change after it is declared";

function boundedText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** The declared origin, `undefined` when the field is absent, or `"invalid"` for any other shape. */
export function parseRemoteOrigin(value: unknown): RpcRemoteOrigin | undefined | "invalid" {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid";
	const deviceId: unknown = Reflect.get(value, "deviceId");
	const deviceName: unknown = Reflect.get(value, "deviceName");
	const keys = Object.keys(value);
	if (keys.some((key) => key !== "deviceId" && key !== "deviceName")) return "invalid";
	if (!boundedText(deviceId, MAX_DEVICE_ID_CHARACTERS)) return "invalid";
	if (deviceName === undefined) return { deviceId };
	if (!boundedText(deviceName, MAX_DEVICE_NAME_CHARACTERS)) return "invalid";
	return { deviceId, deviceName };
}

/**
 * Validates a `set_client_info.remoteOrigin` against what the connection already declared, before anything of the
 * declaration is committed: the origin to record (none when the field is absent), or the refusal to answer.
 */
export function remoteOriginDeclaration(
	value: unknown,
	accepts: (origin: RpcRemoteOrigin) => boolean,
): { readonly origin: RpcRemoteOrigin | undefined } | { readonly refusal: string } {
	const origin = parseRemoteOrigin(value);
	if (origin === "invalid") return { refusal: REMOTE_ORIGIN_INVALID };
	if (origin !== undefined && !accepts(origin)) return { refusal: REMOTE_ORIGIN_FIXED };
	return { origin };
}

export function sameRemoteOrigin(a: RpcRemoteOrigin, b: RpcRemoteOrigin): boolean {
	return a.deviceId === b.deviceId && a.deviceName === b.deviceName;
}

export function remoteOriginField(origin: RpcRemoteOrigin | undefined): { remoteOrigin?: RpcRemoteOrigin } {
	return origin === undefined ? {} : { remoteOrigin: origin };
}

export function originField(origin: RpcRemoteOrigin | undefined): { origin?: RpcRemoteOrigin } {
	return origin === undefined ? {} : { origin };
}
