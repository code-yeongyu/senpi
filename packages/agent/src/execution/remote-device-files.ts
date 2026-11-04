import type { JsonValue } from "@earendil-works/pi-ai";
import {
	DeviceFileError,
	type DeviceFileOp,
	type DeviceFiles,
	type DeviceFileStat,
	decodeBase64,
	encodeBase64,
	FILE_CHANNEL,
	FILE_CHANNEL_MAX_BYTES,
	fileOutcomeOf,
} from "./device-files.ts";
import type { HandLink, HandReply } from "./remote-link.ts";
import type { ExecutionScope } from "./tool-host.ts";

/** How long an operation waits for the hand's `hello` before answering `unsupported` (C1). */
export const HELLO_WAIT_MS = 5000;

const GRANT_REFUSALS = new Set(["grant_missing", "grant_expired", "workspace_unknown", "capability_missing"]);

function refusalError(reason: string): DeviceFileError {
	if (GRANT_REFUSALS.has(reason)) return new DeviceFileError("refused_by_grant", reason);
	if (reason === "hand_closed" || reason.startsWith("scope_unavailable"))
		return new DeviceFileError("hand_unreachable", reason);
	return new DeviceFileError("protocol", reason);
}

function valueOf(reply: HandReply): JsonValue {
	switch (reply.kind) {
		case "settled": {
			const outcome = fileOutcomeOf(reply.result.details);
			if (outcome === undefined) throw new DeviceFileError("protocol", "the hand sent no file outcome");
			if (!outcome.ok) throw new DeviceFileError(outcome.code, outcome.message);
			return outcome.value;
		}
		case "terminal": {
			const { reason, uncertain } = reply.terminal;
			throw new DeviceFileError("interrupted", `the operation ended without an outcome (${reason})`, {
				reason,
				uncertain,
			});
		}
		case "refused":
			throw refusalError(reply.reason);
		case "aborted":
			throw new DeviceFileError("aborted", "the operation was aborted");
		case "unreachable":
			throw new DeviceFileError("hand_unreachable", reply.reason);
		case "closed":
			throw new DeviceFileError("hand_unreachable", "the hand link was closed");
	}
}

/**
 * A session's {@link DeviceFiles} on a hand (S40): each operation is one `file` message on the scope's lane, after the
 * hand announced the channel in its `hello` (or `unsupported`, sent nowhere). A write over the limit is refused here,
 * before anything is sent; the hand checks the limit again before it reads or writes.
 */
export function createRemoteDeviceFiles(link: HandLink, scope: ExecutionScope, mintId: () => string): DeviceFiles {
	const call = async (op: DeviceFileOp, args: JsonValue, signal: AbortSignal | undefined): Promise<JsonValue> => {
		const hello = await link.hello(HELLO_WAIT_MS, signal);
		if (signal?.aborted) throw new DeviceFileError("aborted", "the operation was aborted");
		if (hello === undefined || !hello.ops.includes(FILE_CHANNEL))
			throw new DeviceFileError("unsupported", "the hand serves no file channel");
		return valueOf(await link.dispatch({ kind: "file", executionId: mintId(), scope, op, args }, signal));
	};
	return {
		read: async (path, options) => {
			const value = await call("read", { path }, options?.signal);
			if (typeof value !== "string") throw new DeviceFileError("protocol", "malformed read outcome");
			return decodeBase64(value);
		},
		write: async (path, data, options) => {
			if (data.byteLength > FILE_CHANNEL_MAX_BYTES) throw new DeviceFileError("too_large", path);
			const exclusive = options?.exclusive === true;
			await call("write", { path, data: encodeBase64(data), exclusive }, options?.signal);
		},
		list: async (path, options) => {
			const value = await call("list", { path }, options?.signal);
			if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string"))
				throw new DeviceFileError("protocol", "malformed list outcome");
			return value as string[];
		},
		stat: async (path, options) => (await call("stat", { path }, options?.signal)) as unknown as DeviceFileStat,
		rename: async (from, to, options) => {
			await call("rename", { path: from, to }, options?.signal);
		},
		remove: async (path, options) => {
			await call("remove", { path }, options?.signal);
		},
		mkdir: async (path, options) => {
			await call("mkdir", { path }, options?.signal);
		},
	};
}
