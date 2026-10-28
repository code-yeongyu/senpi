import { isPresetRule } from "./config.ts";
import type { DispatchPermissionState } from "./dispatch-policy.ts";
import { permissionRequestsFor } from "./parsers.ts";
import type { PermissionPresetName, Ruleset } from "./types.ts";
import { Wildcard } from "./wildcard.ts";

export interface CellOperation {
	readonly tool: "bash" | "read" | "write" | "ls";
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
	readonly decide: (call: CellOperation) => CellDecision;
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

/** Synchronous deny projection only: no ask, auto judge or approval event. */
export function decideCellOperation(sessionManager: object, call: CellOperation): CellDecision {
	const registration = sessions.get(sessionManager)?.registration;
	if (!registration?.alive) return unavailable("unavailable");
	return registration.decide(call);
}

export function createCellDecision(
	stateFor: () => DispatchPermissionState,
	provenance: (permission: string, patterns: readonly string[]) => CellDenyRule | undefined,
): (call: CellOperation) => CellDecision {
	return (call) => {
		const state = stateFor();
		if (state.setupError !== null) return unavailable("setup_failed");
		if (!state.service || !state.parsers) return unavailable("unavailable");
		const requests = permissionRequestsFor(() => [], state.parsers, call.tool, call.input, call.cwd);
		for (const request of requests) {
			for (const pattern of request.patterns) {
				const targets = request.ruleAliases ?? pattern;
				const decision = state.service.dispatchDecision(request.permission, targets, {
					presetBound: state.preset === "auto",
				});
				if (decision.action !== "deny") continue;
				const configured = provenance(request.permission, typeof targets === "string" ? [targets] : targets);
				const deciding = decision.rules.find((rule) => rule.action === "deny");
				return {
					action: "deny",
					rule: configured ?? {
						permission: deciding?.permission ?? request.permission,
						pattern: deciding?.pattern ?? pattern,
						layer: "system",
					},
				};
			}
		}
		return { action: "pass" };
	};
}
