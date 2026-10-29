import * as path from "node:path";
import { containsPrefix } from "./alias-detector.ts";
import type { IdentityMatcher } from "./evaluate.ts";
import { type CanonicalPath, identityMatches, PATH_IDENTITY_VERSION } from "./path-identity.ts";
import type { PathIdentityResolver } from "./path-identity-host.ts";
import type { RuleIdentityCache } from "./rule-identity-cache.ts";
import type { Rule } from "./types.ts";
import { Wildcard } from "./wildcard.ts";

/** The canonical forms of one request (design 6.2): every alias names one operation, so any of them may match. */
export interface IdentityInput {
	readonly canonical: readonly CanonicalPath[];
	/** Error code when the executed path could not be canonicalized (6.1.3). */
	readonly unresolvable?: string;
	/** Set when a timed-out DENY rule of the class could have reached this request through an alias (6.5.1). */
	readonly failClosed?: boolean;
}

/** The kernel-supplied canonical of a cell operation, honoured only at the host's own PATH_IDENTITY_VERSION. */
export interface KernelCanonical {
	readonly canonical?: { readonly v: number; readonly path: string; readonly foldCase: boolean };
	readonly unresolvable?: string;
}

/** The permission classes with a path target; only these take the identity route (M4). */
export const PATH_PERMISSIONS: ReadonlySet<string> = new Set(["read", "edit", "list", "grep"]);

/** The static and approved rules that could match by identity: a path class, and a pattern other than `*`. */
export function pathRulesOf(rules: readonly Rule[]): Rule[] {
	return rules.filter(
		(rule) => rule.pattern !== "*" && [...PATH_PERMISSIONS].some((member) => Wildcard.match(member, rule.permission)),
	);
}

/**
 * True when a static or approved rule of a path class could match by identity (R3-H2 gate). With the
 * resolver unavailable only a request that brings its own current canonical (a JS cell) keeps the route:
 * it needs no worker, so its decision stays exact; every other request matches by spelling only.
 */
export function identityWanted(
	resolver: PathIdentityResolver | undefined,
	rules: readonly Rule[],
	permission: string,
	kernel?: KernelCanonical,
): boolean {
	if (!resolver || !PATH_PERMISSIONS.has(permission)) return false;
	if (resolver.unavailable !== undefined && kernel?.canonical?.v !== PATH_IDENTITY_VERSION) return false;
	return pathRulesOf(rules).length > 0;
}

export interface IdentityContext {
	readonly resolver: PathIdentityResolver | undefined;
	readonly cache: RuleIdentityCache;
	readonly mountRewrite: (value: string) => string;
	identityWanted(permission: string, kernel?: KernelCanonical): boolean;
}

/**
 * The identity input for one request (6.2, 6.5.1). Synchronous when the kernel supplied a current canonical
 * and no rule of the class is pending or timed out; otherwise it awaits the resolver worker. Never throws:
 * every resolver failure becomes `unresolvable`.
 */
export function prepareIdentity(
	context: IdentityContext,
	permission: string,
	executed: readonly string[],
	cwd?: string,
	kernel?: KernelCanonical,
): IdentityInput | Promise<IdentityInput> {
	const none: IdentityInput = { canonical: [] };
	if (!context.identityWanted(permission, kernel) || !context.resolver) return none;
	if (kernel?.unresolvable !== undefined && !kernel.canonical)
		return { canonical: [], unresolvable: kernel.unresolvable };
	const current = kernel?.canonical?.v === PATH_IDENTITY_VERSION ? kernel.canonical : undefined;
	// Unavailable resolver: the rule forms it managed to fill before failing are all there will be, and
	// nothing can time out, so the kernel canonical is used as is.
	if (current && context.resolver.unavailable !== undefined) {
		return { canonical: [{ path: current.path, foldCase: current.foldCase }] };
	}
	const settle = context.cache.settleRules(permission);
	const timedOut = () => context.cache.timedOutDenies(permission);
	if (current && settle === undefined && timedOut().length === 0) {
		return { canonical: [{ path: current.path, foldCase: current.foldCase }] };
	}
	const resolver = context.resolver;
	return (async () => {
		if (settle) await settle;
		let canonical: CanonicalPath[] = [];
		let unresolvable: string | undefined;
		if (current) canonical = [{ path: current.path, foldCase: current.foldCase }];
		else {
			for (const value of executed) {
				try {
					canonical.push(await resolver.canonicalize(value, cwd));
				} catch (error) {
					unresolvable = (error as { code?: string }).code ?? "EUNKNOWN";
				}
			}
		}
		const failClosed = await failsClosed(context, permission, executed, canonical, current !== undefined);
		return {
			canonical,
			...(unresolvable === undefined ? {} : { unresolvable }),
			...(failClosed ? { failClosed } : {}),
		};
	})();
}

/** 6.5.1: deny only when a timed-out DENY rule of the class could reach this request through an alias. */
async function failsClosed(
	context: IdentityContext,
	permission: string,
	executed: readonly string[],
	canonical: readonly CanonicalPath[],
	kernelExact: boolean,
): Promise<boolean> {
	const timedOut = context.cache.timedOutDenies(permission);
	if (timedOut.length === 0 || !context.resolver) return false;
	const resolver = context.resolver;
	const aliasInPlay = async (value: string, index: number): Promise<boolean> => {
		const known = canonical[index];
		if (kernelExact && known) return known.path !== value;
		if (resolver.breakerState(resolver.volumeKey(value)) === "open") return true;
		return resolver.detect(value);
	};
	for (const [index, value] of executed.entries()) {
		if (await aliasInPlay(value, index)) return true;
		const requestCanonical = canonical[index]?.path ?? (await resolver.walk(value).catch(() => undefined));
		if (requestCanonical === undefined) return true;
		for (const rule of timedOut) {
			if (!context.cache.aliasBearing(rule.pattern)) continue;
			if (context.cache.anchoredPrefix(rule.pattern) === "") continue;
			// The rule side was walked once at rules load on the worker; a pending or failed walk is over-inclusive.
			const walked = context.cache.walkedPrefix(rule.pattern);
			if (typeof walked !== "string") return true;
			const foldCase = canonical[index]?.foldCase ?? (process.platform === "darwin" || process.platform === "win32");
			if (containsPrefix(walked, requestCanonical, context.mountRewrite, foldCase, (v) => v)) return true;
		}
	}
	return false;
}

/** The identity predicate for one request: takes the RULE pattern only and tests every canonical path (H1). */
export function identityMatcher(
	cache: RuleIdentityCache,
	permission: string,
	identity: IdentityInput | undefined,
	rewrite: (value: string) => string,
	resolverUnavailable = false,
): IdentityMatcher | undefined {
	if (!identity || !PATH_PERMISSIONS.has(permission) || identity.canonical.length === 0) return undefined;
	return (rulePattern) => {
		const cached = cache.stateOf(rulePattern);
		const entry = typeof cached === "string" && resolverUnavailable ? cache.lexicalForm(rulePattern) : cached;
		if (entry === undefined || typeof entry === "string") return false;
		return identity.canonical.some((request) => identityMatches(entry, request, Wildcard.match, path.sep, rewrite));
	};
}
