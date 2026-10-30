import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep, win32 } from "node:path";
import type { CellAuthorityToken } from "../../src/kernels/js/kernel-contract.ts";
import type { CellDecision, CellOperation } from "../../src/kernels/js/permission-slots.mjs";
import { createPathIdentity, PATH_IDENTITY_VERSION } from "../../src/kernels/shared/path-identity.mjs";

export interface RecordedCall {
	readonly tool: string;
	readonly path?: string;
	readonly executedPath?: string;
	readonly canonical?: string;
	readonly unresolvable?: string;
	readonly command?: string;
}

/**
 * Design 6.6: the fixture decider decides by file identity. A request is denied when its written or
 * executed spelling equals a denied path, when the canonical form the kernel reports (current
 * version) equals the canonical form of a denied path (a `<dir>/*` rule covers one level below its
 * canonical prefix), or when the request is unresolvable while any deny exists; a stale or absent
 * canonical is recomputed here from the executed path, as the host would.
 */
export function createIdentityDecider(denied: ReadonlySet<string>, calls?: RecordedCall[]) {
	const identity = createPathIdentity({
		realpathNative: (value) => realpathSync.native(value),
		lstat: (value, options) => (options ? lstatSync(value, options) : lstatSync(value, { bigint: true })),
		readlink: (value) => readlinkSync(value),
		pathApi: { join, dirname, basename, isAbsolute, sep, win32Resolve: win32.resolve },
		platform: process.platform,
	});
	const canonicalOf = (value: string, cwd?: string): string | undefined => {
		try {
			return identity.canonical(value, cwd).path;
		} catch {
			return undefined;
		}
	};
	const covers = (rule: string, requestCanonical: string): boolean => {
		if (!rule.includes("*")) return canonicalOf(rule) === requestCanonical;
		const split = identity.canonicalRule(rule);
		if (!split?.prefix || split.suffix !== "/*") return false;
		const rest = requestCanonical.startsWith(`${split.prefix}/`)
			? requestCanonical.slice(split.prefix.length + 1)
			: undefined;
		return rest !== undefined && rest.length > 0 && !rest.includes("/");
	};
	const deny = (tool: string): CellDecision => ({
		action: "deny",
		rule: { permission: tool, pattern: "boundary", layer: "user" },
	});
	return (_token: CellAuthorityToken, call: CellOperation): CellDecision => {
		const input = call.input;
		calls?.push({
			tool: call.tool,
			...(input.path !== undefined ? { path: input.path } : {}),
			...(input.executedPath !== undefined ? { executedPath: input.executedPath } : {}),
			...(input.canonical ? { canonical: input.canonical.path } : {}),
			...(input.unresolvable !== undefined ? { unresolvable: input.unresolvable } : {}),
			...(input.command !== undefined ? { command: input.command } : {}),
		});
		if (input.command !== undefined) {
			return [...denied].some((path) => input.command?.includes(path)) ? deny(call.tool) : { action: "pass" };
		}
		if (input.path === undefined) return { action: "pass" };
		if (denied.has(input.path) || (input.executedPath !== undefined && denied.has(input.executedPath))) {
			return deny(call.tool);
		}
		if (input.unresolvable !== undefined && denied.size > 0) return deny(call.tool);
		const requestCanonical =
			input.canonical && input.canonical.v === PATH_IDENTITY_VERSION
				? input.canonical.path
				: canonicalOf(input.executedPath ?? input.path, call.cwd);
		if (requestCanonical === undefined) return { action: "pass" };
		for (const rule of denied) {
			if (covers(rule, requestCanonical)) return deny(call.tool);
		}
		return { action: "pass" };
	};
}
