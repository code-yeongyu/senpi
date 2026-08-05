import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "../../../../config.ts";
import type { Rule, Ruleset } from "./types.ts";

const PERMISSIONS_FILE = "permissions-approved.jsonl";

function getPermissionsPath(projectDir: string): string {
	return path.join(projectDir, CONFIG_DIR_NAME, PERMISSIONS_FILE);
}

function isRule(value: unknown): value is Rule {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.permission === "string" &&
		typeof candidate.pattern === "string" &&
		(candidate.action === "allow" || candidate.action === "deny" || candidate.action === "ask")
	);
}

export function loadApproved(projectDir: string): Ruleset {
	const filePath = getPermissionsPath(projectDir);

	if (!fs.existsSync(filePath)) {
		return [];
	}

	const content = fs.readFileSync(filePath, "utf-8");
	const lines = content.split("\n").filter((line) => line.trim() !== "");

	const rules: Rule[] = [];
	for (const line of lines) {
		try {
			const rule: unknown = JSON.parse(line);
			if (isRule(rule)) rules.push(rule);
		} catch {}
	}

	return rules;
}

export function appendApproved(projectDir: string, rules: Rule[]): void {
	if (rules.length === 0) {
		return;
	}

	const filePath = getPermissionsPath(projectDir);
	const dir = path.dirname(filePath);

	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const lines = `${rules.map((rule) => JSON.stringify(rule)).join("\n")}\n`;
	fs.appendFileSync(filePath, lines, { flag: "a" });
}

export function clearApproved(projectDir: string): void {
	const filePath = getPermissionsPath(projectDir);

	if (fs.existsSync(filePath)) {
		fs.unlinkSync(filePath);
	}
}

export function compactApproved(projectDir: string): void {
	const filePath = getPermissionsPath(projectDir);

	if (!fs.existsSync(filePath)) {
		return;
	}

	const rules = loadApproved(projectDir);
	const seen = new Map<string, Rule>();

	for (const rule of rules) {
		const key = `${rule.permission}:${rule.pattern}`;
		seen.set(key, rule);
	}

	const uniqueRules = Array.from(seen.values());
	const lines = uniqueRules.map((rule) => JSON.stringify(rule)).join("\n");
	fs.writeFileSync(filePath, lines ? `${lines}\n` : "", { flag: "w" });
}
