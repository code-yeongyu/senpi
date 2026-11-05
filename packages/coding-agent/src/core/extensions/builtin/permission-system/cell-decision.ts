import { resolve } from "node:path";
import { isPresetRule } from "./config.ts";
import type { DispatchPermissionState } from "./dispatch-policy.ts";
import type { IdentityMatcher } from "./evaluate.ts";
import { permissionRequestsFor } from "./parsers.ts";
import type { IdentityInput, KernelCanonical } from "./service.ts";
import type { PermissionPresetName, Ruleset } from "./types.ts";
import { Wildcard } from "./wildcard.ts";

export interface CellOperation {
	readonly tool: "bash" | "read" | "write" | "ls";
	/** `path` as written, `executedPath` as handed to the runtime, `canonical`/`unresolvable` from the kernel thread (design 6.3.1). */
	readonly input: Record<string, unknown>;
	readonly cwd: string;
}

export interface CellDenyRule {
	readonly permission: string;
	readonly pattern: string;
	readonly layer: string;
}

export type CellDecision = { readonly action: "pass" } | { readonly action: "deny"; readonly rule: CellDenyRule };

export interface CellEnforcementState {
	readonly active: boolean;
	readonly alive: boolean;
	readonly epoch: number;
}

interface Registration {
	readonly decide: (call: CellOperation) => CellDecision | Promise<CellDecision>;
	readonly refresh: () => void;
	alive: boolean;
}

interface Enforcement {
	active: boolean;
	epoch: number;
	fingerprint: string;
	registration?: Registration;
	readonly listeners: Set<(state: CellEnforcementState) => void>;
}

const sessions = new WeakMap<object, Enforcement>();

function enforcementFor(session: object): Enforcement {
	let enforcement = sessions.get(session);
	if (!enforcement) {
		enforcement = { active: false, epoch: 0, fingerprint: "", listeners: new Set() };
		sessions.set(session, enforcement);
	}
	return enforcement;
}

function snapshot(enforcement: Enforcement): CellEnforcementState {
	return {
		active: enforcement.active,
		alive: enforcement.registration?.alive ?? false,
		epoch: enforcement.epoch,
	};
}

function publish(enforcement: Enforcement): void {
	const state = snapshot(enforcement);
	for (const listener of enforcement.listeners) listener(state);
}

/** Retiring an older extension load must not retire its replacement. */
export function registerCellAuthorizer(
	session: object,
	decide: Registration["decide"],
	refresh: Registration["refresh"],
): () => void {
	const enforcement = enforcementFor(session);
	const registration: Registration = { decide, refresh, alive: true };
	if (enforcement.registration) enforcement.registration.alive = false;
	enforcement.registration = registration;
	publish(enforcement);
	return () => {
		if (!registration.alive) return;
		registration.alive = false;
		if (enforcement.registration === registration) publish(enforcement);
	};
}

/** Compare the full ordered user rules, not just the deny subset. */
export function updateCellEnforcement(
	session: object,
	rules: Ruleset,
	preset: PermissionPresetName | null,
	setupFailed = false,
): void {
	const enforcement = enforcementFor(session);
	const userRules = rules.filter((rule) => !isPresetRule(rule));
	const active =
		setupFailed ||
		userRules.some(
			(rule) =>
				rule.action === "deny" &&
				["bash", "edit", "read", "list", "external_directory"].some((permission) =>
					Wildcard.match(permission, rule.permission),
				),
		);
	const fingerprint = JSON.stringify([userRules, preset, setupFailed]);
	const revoked = fingerprint !== enforcement.fingerprint && (enforcement.active || active);
	enforcement.fingerprint = fingerprint;
	enforcement.active = active;
	if (revoked) {
		enforcement.epoch += 1;
		publish(enforcement);
	}
}

export function cellEnforcementState(sessionManager: object): CellEnforcementState {
	const enforcement = enforcementFor(sessionManager);
	if (enforcement.registration?.alive) enforcement.registration.refresh();
	return snapshot(enforcement);
}

export function onCellEnforcementChange(
	sessionManager: object,
	callback: (state: CellEnforcementState) => void,
): () => void {
	const enforcement = enforcementFor(sessionManager);
	enforcement.listeners.add(callback);
	return () => {
		enforcement.listeners.delete(callback);
	};
}

function unavailable(pattern: string): CellDecision {
	return { action: "deny", rule: { permission: "permission_authority", pattern, layer: "system" } };
}

/**
 * Deny projection only: no ask, auto judge or approval event. Synchronous for a JS cell carrying a
 * current kernel canonical; a Promise only when the host must canonicalize on the resolver worker.
 */
export function decideCellOperation(sessionManager: object, call: CellOperation): CellDecision | Promise<CellDecision> {
	const registration = sessions.get(sessionManager)?.registration;
	if (!registration?.alive) return unavailable("unavailable");
	return registration.decide(call);
}

function kernelCanonicalOf(input: Record<string, unknown>): KernelCanonical | undefined {
	const canonical = input.canonical;
	const unresolvable = typeof input.unresolvable === "string" ? input.unresolvable : undefined;
	if (canonical !== null && typeof canonical === "object") {
		const { v, path, foldCase } = canonical as { v?: unknown; path?: unknown; foldCase?: unknown };
		if (typeof v === "number" && typeof path === "string" && typeof foldCase === "boolean") {
			return { canonical: { v, path, foldCase } };
		}
	}
	return unresolvable === undefined ? undefined : { unresolvable };
}

const WRITE_TOOLS = new Set(["write", "bash"]);

export function createCellDecision(
	stateFor: () => DispatchPermissionState,
	provenance: (
		permission: string,
		patterns: readonly string[],
		matchesIdentity?: IdentityMatcher,
	) => CellDenyRule | undefined,
): (call: CellOperation) => CellDecision | Promise<CellDecision> {
	return (call) => {
		const state = stateFor();
		if (state.setupError !== null) return unavailable("setup_failed");
		if (!state.service || !state.parsers) return unavailable("unavailable");
		const service = state.service;
		const requests = permissionRequestsFor(() => [], state.parsers, call.tool, call.input, call.cwd);
		const written = typeof call.input.path === "string" ? call.input.path : undefined;
		const executed =
			typeof call.input.executedPath === "string"
				? call.input.executedPath
				: written === undefined
					? undefined
					: resolve(call.cwd, written);
		const kernel = kernelCanonicalOf(call.input);
		const settle = (): CellDecision => {
			if (WRITE_TOOLS.has(call.tool)) service.noteMutation(executed);
			return { action: "pass" };
		};
		const decideRequest = (
			request: (typeof requests)[number],
			pattern: string,
			identity: IdentityInput | undefined,
		): CellDecision | undefined => {
			const aliases = request.ruleAliases ?? [pattern];
			const targets =
				executed !== undefined ? [...new Set([...aliases, executed])] : (request.ruleAliases ?? pattern);
			const decision = service.dispatchDecision(request.permission, targets, {
				presetBound: state.preset === "auto",
				...(identity ? { identity } : {}),
			});
			if (decision.action !== "deny") return undefined;
			const matcher = service.identityMatcher(request.permission, identity);
			const configured = provenance(request.permission, typeof targets === "string" ? [targets] : targets, matcher);
			const deciding = decision.rules.find((rule) => rule.action === "deny");
			return {
				action: "deny",
				rule: configured ?? {
					permission: deciding?.permission ?? request.permission,
					pattern: deciding?.pattern ?? pattern,
					layer: "system",
				},
			};
		};
		const pendingIdentities: Promise<IdentityInput>[] = [];
		const plan: {
			request: (typeof requests)[number];
			pattern: string;
			identity: IdentityInput | Promise<IdentityInput> | undefined;
		}[] = [];
		for (const request of requests) {
			for (const pattern of request.patterns) {
				const identity =
					executed !== undefined && service.identityWanted(request.permission, kernel)
						? service.prepareIdentity(request.permission, [executed], call.cwd, kernel)
						: undefined;
				if (identity instanceof Promise) pendingIdentities.push(identity);
				plan.push({ request, pattern, identity });
			}
		}
		if (pendingIdentities.length === 0) {
			for (const step of plan) {
				const denied = decideRequest(
					step.request,
					step.pattern,
					step.identity instanceof Promise ? undefined : step.identity,
				);
				if (denied) return denied;
			}
			return settle();
		}
		return (async () => {
			for (const step of plan) {
				const identity = step.identity instanceof Promise ? await step.identity : step.identity;
				const denied = decideRequest(step.request, step.pattern, identity);
				if (denied) return denied;
			}
			return settle();
		})();
	};
}
