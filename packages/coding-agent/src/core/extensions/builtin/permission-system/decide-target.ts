import * as fs from "node:fs";
import * as path from "node:path";
import { isPresetRule } from "./config.ts";
import { evaluate, evaluateExternalSpelling, evaluateWithIdentity, type IdentityMatcher } from "./evaluate.ts";
import { type IdentityInput, PATH_PERMISSIONS } from "./identity-decision.ts";
import type { PermissionPresetName, Rule, Ruleset } from "./types.ts";
import { Wildcard } from "./wildcard.ts";

export interface DecisionOptions {
	readonly approveBlanketAsk?: boolean;
	readonly presetBound?: boolean;
	readonly ruleAliases?: readonly string[] | undefined;
	readonly originalPaths?: readonly string[] | undefined;
	readonly identity?: IdentityInput | undefined;
}

export interface Decision {
	readonly action: Rule["action"];
	readonly rules: readonly Rule[];
}

export interface DecisionContext {
	readonly staticRuleset: Ruleset;
	readonly approved: Ruleset;
	readonly preset: PermissionPresetName | undefined;
	readonly protectedStorePath: string | undefined;
	identityMatcher(permission: string, identity: IdentityInput | undefined): IdentityMatcher | undefined;
}

/** deny > ask > allow. */
const RESTRICTIVENESS: Readonly<Record<Rule["action"], number>> = { allow: 0, ask: 1, deny: 2 };

const unresolvedPattern = (code: string) => `(path could not be resolved: ${code})`;

export function decideTarget(
	context: DecisionContext,
	permission: string,
	target: string | readonly string[],
	options: DecisionOptions,
	approvedTarget = target,
	preserveAncestry = false,
	canonicalCase?: (value: string) => string,
): Decision {
	const identity = permission === "external_directory" ? undefined : options.identity;
	const matchesIdentity = context.identityMatcher(permission, identity);
	const evaluateTarget = (ruleset: Ruleset) =>
		preserveAncestry
			? evaluateExternalSpelling(target, ruleset, canonicalCase)
			: evaluateWithIdentity(permission, target, ruleset, matchesIdentity);
	const evaluateApproved = (approvedRuleset: Ruleset) =>
		preserveAncestry
			? evaluate(permission, approvedTarget, approvedRuleset)
			: evaluateWithIdentity(permission, approvedTarget, approvedRuleset, matchesIdentity);
	// 6.1.3 / 6.5.1: an unresolvable or alias-involved request while a DENY of its class exists or is
	// timed out is refused with the synthetic rule; a plain request never is.
	if (identity && PATH_PERMISSIONS.has(permission)) {
		const code = identity.failClosed ? "ETIMEDOUT" : identity.unresolvable;
		const denyExists = [...context.staticRuleset, ...context.approved].some(
			(rule) => rule.action === "deny" && Wildcard.match(permission, rule.permission),
		);
		if (code !== undefined && denyExists) {
			return { action: "deny", rules: [{ permission, pattern: unresolvedPattern(code), action: "deny" }] };
		}
	}
	// Defence in depth (HIGH 1): the agent's own tools never touch the approvals store, whatever
	// rules say. The target's real path is compared against the store's real path.
	if (context.protectedStorePath !== undefined && targetIsProtectedStore(context.protectedStorePath, target)) {
		return { action: "deny", rules: [{ permission, pattern: "*", action: "deny" }] };
	}
	if (!options.presetBound) {
		// HIGH 2: a configured (settings/CLI) decision outranks the preset's wildcard and any
		// approval. Evaluate the user's rules with their own last-match order; when the user's
		// decision is a deny it wins outright, and a preset wildcard-ask never masks it. The preset
		// only fills the gap the user left (no user rule matched, or the user decision is an ask).
		const userRules = context.staticRuleset.filter((rule) => !isPresetRule(rule));
		const userRule = evaluateTarget(userRules);
		if (userRules.includes(userRule) && userRule.action === "deny") {
			return { action: "deny", rules: [{ ...userRule }] };
		}
		const configured = evaluateTarget(context.staticRuleset);
		if (configured.action === "deny") return { action: "deny", rules: [{ ...configured }] };
		const approvedRule = evaluateApproved(context.approved);
		if (context.approved.includes(approvedRule) && approvedRule.action === "allow") {
			return { action: "allow", rules: [{ ...approvedRule }] };
		}
		// Full access means no prompts: a settings/CLI ask collapses to allow here, while a deny
		// stays denied. This is the one dedicated full-access decision (senpi#2465).
		const action = context.preset === "full-access" && configured.action === "ask" ? "allow" : configured.action;
		return { action, rules: [{ ...configured }] };
	}
	const presetRules = context.staticRuleset.filter((rule) => isPresetRule(rule));
	const userRules = context.staticRuleset.filter((rule) => !isPresetRule(rule));
	const presetRule = evaluateTarget(presetRules);
	const preset = presetRule.action === "ask" && options.approveBlanketAsk ? "allow" : presetRule.action;
	const userRule = evaluateTarget(userRules);
	const user = userRules.includes(userRule) ? userRule.action : undefined;
	const combined = user === undefined || RESTRICTIVENESS[preset] >= RESTRICTIVENESS[user] ? preset : user;
	const rules = [presetRule, ...(user === undefined ? [] : [userRule])].map((rule) => ({ ...rule }));
	if (combined !== "ask") return { action: combined, rules };
	const remembered = evaluateApproved(context.approved);
	if (context.approved.includes(remembered) && remembered.action === "allow") {
		return { action: "allow", rules: [...rules, { ...remembered }] };
	}
	return { action: "ask", rules };
}

/** True when any target path resolves (real path, case-folded on macOS) to the approvals store. */
function targetIsProtectedStore(store: string, target: string | readonly string[]): boolean {
	const targets = typeof target === "string" ? [target] : target;
	for (const value of targets) {
		const resolved = canonicalForCompare(value);
		if (resolved !== undefined && resolved === canonicalForCompare(store)) return true;
	}
	return false;
}

/**
 * The real path to compare, case-folded on macOS. A path that does not exist yet (the store, and
 * possibly its directories, before the first answer is written) resolves through its nearest
 * EXISTING ancestor's real path at any depth, plus the missing tail, so the agent cannot create the
 * store first. A bare name has no directory part and cannot name the store, which lives outside the
 * workspace.
 */
function canonicalForCompare(value: string): string | undefined {
	if (!value.includes("/") && !value.includes(path.sep)) return undefined;
	const fold = (real: string) => (process.platform === "darwin" ? real.toLowerCase() : real);
	let existing = path.resolve(value);
	const missing: string[] = [];
	for (;;) {
		try {
			return fold(path.join(fs.realpathSync.native(existing), ...missing));
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return undefined;
			missing.unshift(path.basename(existing));
			existing = parent;
		}
	}
}
