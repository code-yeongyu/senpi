import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendApproved,
	clearApproved,
	compactApproved,
	loadApproved,
} from "../../src/core/extensions/builtin/permission-system/storage.js";
import type { Rule } from "../../src/core/extensions/builtin/permission-system/types.js";

describe("permission storage", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "permission-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("loadApproved", () => {
		it("returns empty array when file does not exist", () => {
			// when
			const result = loadApproved(tempDir);

			// then
			expect(result).toEqual([]);
		});

		it("returns parsed rules from existing file", () => {
			// given
			const rules: Rule[] = [
				{ permission: "bash", pattern: "git *", action: "allow" },
				{ permission: "write", pattern: "*.ts", action: "ask" },
			];
			appendApproved(tempDir, rules);

			// when
			const result = loadApproved(tempDir);

			// then
			expect(result).toEqual(rules);
		});

		it("skips malformed lines and returns valid rules", () => {
			// given
			const piDir = path.join(tempDir, ".pi");
			fs.mkdirSync(piDir, { recursive: true });
			const filePath = path.join(piDir, "permissions-approved.jsonl");
			fs.writeFileSync(
				filePath,
				'{"permission":"bash","pattern":"git *","action":"allow"}\ninvalid json\n{"permission":"write","pattern":"*.ts","action":"deny"}\n',
			);

			// when
			const result = loadApproved(tempDir);

			// then
			expect(result).toEqual([
				{ permission: "bash", pattern: "git *", action: "allow" },
				{ permission: "write", pattern: "*.ts", action: "deny" },
			]);
		});
	});

	describe("appendApproved", () => {
		it("creates .pi directory if missing", () => {
			// given
			const rules: Rule[] = [{ permission: "bash", pattern: "*", action: "allow" }];

			// when
			appendApproved(tempDir, rules);

			// then
			const piDir = path.join(tempDir, ".pi");
			expect(fs.existsSync(piDir)).toBe(true);
		});

		it("appends rules as JSONL lines", () => {
			// given
			const rules: Rule[] = [
				{ permission: "bash", pattern: "git *", action: "allow" },
				{ permission: "read", pattern: "*.md", action: "allow" },
			];

			// when
			appendApproved(tempDir, rules);

			// then
			const filePath = path.join(tempDir, ".pi", "permissions-approved.jsonl");
			const content = fs.readFileSync(filePath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0])).toEqual(rules[0]);
			expect(JSON.parse(lines[1])).toEqual(rules[1]);
		});

		it("handles multiple appends correctly", () => {
			// given
			const rules1: Rule[] = [{ permission: "bash", pattern: "git *", action: "allow" }];
			const rules2: Rule[] = [{ permission: "write", pattern: "*.ts", action: "ask" }];

			// when
			appendApproved(tempDir, rules1);
			appendApproved(tempDir, rules2);

			// then
			const result = loadApproved(tempDir);
			expect(result).toEqual([...rules1, ...rules2]);
		});

		it("does nothing when rules array is empty", () => {
			// when
			appendApproved(tempDir, []);

			// then
			const filePath = path.join(tempDir, ".pi", "permissions-approved.jsonl");
			expect(fs.existsSync(filePath)).toBe(false);
		});
	});

	describe("clearApproved", () => {
		it("deletes the permissions file", () => {
			// given
			const rules: Rule[] = [{ permission: "bash", pattern: "*", action: "allow" }];
			appendApproved(tempDir, rules);
			const filePath = path.join(tempDir, ".pi", "permissions-approved.jsonl");
			expect(fs.existsSync(filePath)).toBe(true);

			// when
			clearApproved(tempDir);

			// then
			expect(fs.existsSync(filePath)).toBe(false);
		});

		it("does not throw when file does not exist", () => {
			// when/then
			expect(() => clearApproved(tempDir)).not.toThrow();
		});
	});

	describe("compactApproved", () => {
		it("removes duplicate rules keeping last occurrence", () => {
			// given
			const rules: Rule[] = [
				{ permission: "bash", pattern: "git *", action: "allow" },
				{ permission: "bash", pattern: "git *", action: "deny" },
				{ permission: "write", pattern: "*.ts", action: "ask" },
			];
			appendApproved(tempDir, rules);

			// when
			compactApproved(tempDir);

			// then
			const result = loadApproved(tempDir);
			expect(result).toEqual([
				{ permission: "bash", pattern: "git *", action: "deny" },
				{ permission: "write", pattern: "*.ts", action: "ask" },
			]);
		});

		it("handles rules with different permissions but same pattern", () => {
			// given
			const rules: Rule[] = [
				{ permission: "bash", pattern: "*", action: "allow" },
				{ permission: "read", pattern: "*", action: "deny" },
			];
			appendApproved(tempDir, rules);

			// when
			compactApproved(tempDir);

			// then
			const result = loadApproved(tempDir);
			expect(result).toHaveLength(2);
			expect(result).toContainEqual({ permission: "bash", pattern: "*", action: "allow" });
			expect(result).toContainEqual({ permission: "read", pattern: "*", action: "deny" });
		});

		it("does nothing when file does not exist", () => {
			// when/then
			expect(() => compactApproved(tempDir)).not.toThrow();
		});

		it("writes empty file when all rules are duplicates", () => {
			// given
			const rules: Rule[] = [
				{ permission: "bash", pattern: "git *", action: "allow" },
				{ permission: "bash", pattern: "git *", action: "deny" },
			];
			appendApproved(tempDir, rules);

			// when
			compactApproved(tempDir);

			// then
			const result = loadApproved(tempDir);
			expect(result).toEqual([{ permission: "bash", pattern: "git *", action: "deny" }]);
		});
	});

	describe("round-trip", () => {
		it("writes and reads back rules correctly", () => {
			// given
			const originalRules: Rule[] = [
				{ permission: "bash", pattern: "git *", action: "allow" },
				{ permission: "write", pattern: "*.ts", action: "ask" },
				{ permission: "read", pattern: "*.md", action: "allow" },
			];

			// when
			appendApproved(tempDir, originalRules);
			const loadedRules = loadApproved(tempDir);

			// then
			expect(loadedRules).toEqual(originalRules);
		});
	});
});
