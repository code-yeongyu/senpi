import os from "node:os";
import type { PermissionConfig, PermissionPresetName, Rule, Ruleset } from "./types.ts";
import { Wildcard } from "./wildcard.ts";

export const EDIT_TOOLS = ["edit", "write", "apply_patch", "multiedit"];
export const DEFAULT_PERMISSION_PRESET: PermissionPresetName = "full-access";
export const ACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY = "permission_preset_accept_edits";
export const AUTO_PERMISSION_PRESET_CAPABILITY = "permission_preset_auto";

const PERMISSION_PRESET_RULES: Record<PermissionPresetName, Ruleset> = {
	"full-access": [{ permission: "*", pattern: "*", action: "allow" }],
	workspace: [
		{ permission: "*", pattern: "*", action: "ask" },
		{ permission: "read", pattern: "*", action: "allow" },
		{ permission: "list", pattern: "*", action: "allow" },
		{ permission: "grep", pattern: "*", action: "allow" },
		{ permission: "edit", pattern: "*", action: "allow" },
		{ permission: "bash", pattern: "*", action: "allow" },
		{ permission: "external_directory", pattern: "*", action: "ask" },
	],
	"accept-edits": [
		{ permission: "*", pattern: "*", action: "ask" },
		{ permission: "read", pattern: "*", action: "allow" },
		{ permission: "list", pattern: "*", action: "allow" },
		{ permission: "grep", pattern: "*", action: "allow" },
		{ permission: "edit", pattern: "*", action: "allow" },
		{ permission: "bash", pattern: "*", action: "ask" },
		{ permission: "external_directory", pattern: "*", action: "ask" },
	],
	// Ask for everything; auto-policy.ts approves, over this rule only, the calls on its allowlist.
	auto: [{ permission: "*", pattern: "*", action: "ask" }],
	"read-only": [
		{ permission: "*", pattern: "*", action: "ask" },
		{ permission: "read", pattern: "*", action: "allow" },
		{ permission: "list", pattern: "*", action: "allow" },
		{ permission: "grep", pattern: "*", action: "allow" },
		{ permission: "edit", pattern: "*", action: "ask" },
		{ permission: "bash", pattern: "*", action: "ask" },
		{ permission: "external_directory", pattern: "*", action: "ask" },
	],
	ask: [{ permission: "*", pattern: "*", action: "ask" }],
};

export function expand(path: string): string {
	if (path.startsWith("~/")) {
		return os.homedir() + path.slice(1);
	}
	if (path === "~") {
		return os.homedir();
	}
	if (path.startsWith("$HOME/")) {
		return os.homedir() + path.slice(5);
	}
	if (path.startsWith("$HOME")) {
		return os.homedir() + path.slice(5);
	}
	return path;
}

export function fromConfig(config: PermissionConfig): Ruleset {
	const rules: Rule[] = [];

	for (const [permission, value] of Object.entries(config)) {
		if (typeof value === "string") {
			rules.push({ permission, pattern: "*", action: value });
		} else {
			for (const [pattern, action] of Object.entries(value)) {
				rules.push({ permission, pattern: expand(pattern), action });
			}
		}
	}

	return rules;
}

const presetRules = new WeakSet<Rule>();

export function rulesForPreset(preset: PermissionPresetName): Ruleset {
	return PERMISSION_PRESET_RULES[preset].map((rule) => {
		const copy = { ...rule };
		presetRules.add(copy);
		return copy;
	});
}

/** True only for a rule object produced by `rulesForPreset`, never for a user's identical rule. */
export function isPresetRule(rule: Rule): boolean {
	return presetRules.has(rule);
}

export function merge(...rulesets: Ruleset[]): Ruleset {
	return rulesets.flat();
}

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
	const result = new Set<string>();

	for (const tool of tools) {
		const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool;

		const rule = ruleset.findLast((rule) => {
			return Wildcard.match(permission, rule.permission);
		});

		if (rule && rule.pattern === "*" && rule.action === "deny") {
			result.add(tool);
		}
	}

	return result;
}
