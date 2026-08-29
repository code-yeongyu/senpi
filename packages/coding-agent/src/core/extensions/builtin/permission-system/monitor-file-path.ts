import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface ResolvedMonitorFilePath {
	readonly requestedPath: string;
	readonly logicalAbsolutePath: string;
	readonly logicalParent: string;
	readonly canonicalParent: string;
	readonly canonicalPath: string;
	readonly parentDevice: bigint;
	readonly parentInode: bigint;
}

export type MonitorFilePathResolution =
	| { readonly ok: true; readonly value: ResolvedMonitorFilePath }
	| { readonly ok: false; readonly message: string };

const bindings = new WeakMap<object, MonitorFilePathResolution>();

function resolveMonitorFilePath(requestedPath: string, cwd: string): MonitorFilePathResolution {
	const logicalAbsolutePath = resolve(cwd, requestedPath);
	const logicalParent = dirname(logicalAbsolutePath);
	try {
		const canonicalParent = realpathSync(logicalParent);
		const parentStats = lstatSync(canonicalParent, { bigint: true });
		if (!parentStats.isDirectory()) {
			return { ok: false, message: `Monitor parent is not a directory: ${canonicalParent}` };
		}
		return {
			ok: true,
			value: {
				requestedPath,
				logicalAbsolutePath,
				logicalParent,
				canonicalParent,
				canonicalPath: join(canonicalParent, basename(logicalAbsolutePath)),
				parentDevice: parentStats.dev,
				parentInode: parentStats.ino,
			},
		};
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return {
			ok: false,
			message: `Unable to resolve monitor parent directory: ${logicalParent} (${error.message})`,
		};
	}
}

export function bindMonitorFilePath(
	input: Record<string, unknown>,
	requestedPath: string,
	cwd: string,
): MonitorFilePathResolution {
	const resolution = resolveMonitorFilePath(requestedPath, cwd);
	bindings.set(input, resolution);
	return resolution;
}

export function resolveMonitorFilePathForExecution(
	input: object,
	requestedPath: string,
	cwd: string,
): MonitorFilePathResolution {
	const bound = bindings.get(input);
	if (!bound) return resolveMonitorFilePath(requestedPath, cwd);
	if (!bound.ok) return bound;
	if (bound.value.requestedPath !== requestedPath) {
		return { ok: false, message: "Monitor path changed after permission approval." };
	}
	try {
		const currentParent = lstatSync(bound.value.canonicalParent, { bigint: true });
		const currentLogicalParent = realpathSync(bound.value.logicalParent);
		const currentRealpath = realpathSync(bound.value.canonicalParent);
		if (
			!currentParent.isDirectory() ||
			currentLogicalParent !== bound.value.canonicalParent ||
			currentRealpath !== bound.value.canonicalParent ||
			currentParent.dev !== bound.value.parentDevice ||
			currentParent.ino !== bound.value.parentInode
		) {
			return { ok: false, message: "The approved monitor parent changed before execution." };
		}
		return bound;
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return { ok: false, message: `The approved monitor parent changed before execution: ${error.message}` };
	}
}
