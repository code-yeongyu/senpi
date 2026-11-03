import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep, win32 } from "node:path";
import { parentPort } from "node:worker_threads";
import { realpathWithoutOpenStrict } from "../../../../utils/paths.ts";
import { createDetector, readFirmlinks } from "./alias-detector.ts";
import { type MountSnapshot, readMountTable } from "./mount-table.ts";
import { createPathIdentity } from "./path-identity.ts";
import type { ResolverReply, ResolverRequest, ResolverSnapshotMessage } from "./path-identity-protocol.ts";

const MOUNT_REFRESH_MS = 60_000;

function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "EUNKNOWN";
}

export interface ResolverService {
	serve(request: ResolverRequest): ResolverReply;
	snapshot(): ResolverSnapshotMessage;
}

/** The resolver's filesystem work, with the real primitives; the worker entry below hosts it off the main thread. */
export function createResolverService(readTable: () => MountSnapshot = readMountTable): ResolverService {
	const identity = createPathIdentity({
		realpathNative: (value) => realpathSync.native(value),
		lstat: (value, options) => (options ? lstatSync(value, options) : lstatSync(value, { bigint: true })),
		readlink: (value) => readlinkSync(value),
		pathApi: { join, dirname, basename, isAbsolute, sep, win32Resolve: win32.resolve },
		platform: process.platform,
	});
	let detector: ((value: string) => { alias: boolean }) | undefined;
	const snapshot = (): ResolverSnapshotMessage => {
		const table = readTable();
		detector = createDetector(table);
		return { type: "snapshot", snapshot: table, firmlinks: readFirmlinks() };
	};
	const detect = (value: string) => {
		if (!detector) snapshot();
		return detector ? detector(value).alias : true;
	};
	return {
		snapshot,
		serve(request) {
			try {
				switch (request.kind) {
					case "canonicalize":
						return { id: request.id, ok: true, value: identity.canonical(request.path, request.cwd) };
					case "canonicalizeRule":
						return { id: request.id, ok: true, value: identity.canonicalRule(request.pattern, request.cwd) };
					case "detect":
						return { id: request.id, ok: true, value: detect(request.path) };
					case "walk":
						return { id: request.id, ok: true, value: realpathWithoutOpenStrict(request.path) };
					case "refresh":
						return { id: request.id, ok: true, value: undefined };
				}
			} catch (error) {
				return { id: request.id, ok: false, code: codeOf(error) };
			}
		},
	};
}

if (parentPort) {
	const port = parentPort;
	const service = createResolverService();
	const publish = () => port.postMessage(service.snapshot());
	publish();
	setInterval(publish, MOUNT_REFRESH_MS).unref();
	port.on("message", (request: ResolverRequest) => {
		if (request.kind === "refresh") publish();
		port.postMessage(service.serve(request));
	});
}
