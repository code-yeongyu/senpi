import os from "node:os";
import { Wildcard } from "../agent-system/wildcard.js";
import type { PermissionConfig, Rule, Ruleset } from "./types.js";

export const EDIT_TOOLS = ["edit", "write", "apply_patch", "multiedit"];

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
