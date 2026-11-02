import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendApproved,
	approvedStorePath,
	clearApproved,
	compactApproved,
	loadApproved,
} from "../../src/core/extensions/builtin/permission-system/storage.ts";
import type { Rule } from "../../src/core/extensions/builtin/permission-system/types.ts";

const ALLOW_BASH: Rule = { permission: "bash", pattern: "git *", action: "allow" };
const ALLOW_READ: Rule = { permission: "read", pattern: "*.md", action: "allow" };

describe("permission storage", () => {
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-agent-"));
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-project-"));
	});

	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	describe("loadApproved", () => {
		it("returns empty array when the store does not exist", () => {
			// when
			const result = loadApproved(agentDir, projectDir);

			// then
			expect(result).toEqual([]);
		});

		it("returns valid allow rules from the store, dropping anything else", () => {
			// given
			appendApproved(agentDir, projectDir, [ALLOW_BASH, ALLOW_READ]);

			// when
			const result = loadApproved(agentDir, projectDir);

			// then
			expect(result).toEqual([ALLOW_BASH, ALLOW_READ]);
		});

		it("skips malformed lines and drops non-allow or unmarked rules", () => {
			// given a store file whose lines mix valid user-answer rules with forged/invalid ones
			const storePath = approvedStorePath(agentDir, projectDir);
			fs.mkdirSync(path.dirname(storePath), { recursive: true });
			fs.writeFileSync(
				storePath,
				[
					'{"permission":"bash","pattern":"git *","action":"allow","source":"user-answer"}',
					"invalid json",
					'{"permission":"write","pattern":"*.ts","action":"deny","source":"user-answer"}',
					'{"permission":"*","pattern":"*","action":"allow"}',
					'{"permission":"bash","pattern":"ls *","action":"allow"}',
				].join("\n") + "\n",
			);

			// when
			const result = loadApproved(agentDir, projectDir);

			// then only the valid, user-marked allow survives
			expect(result).toEqual([ALLOW_BASH]);
		});
	});

	describe("appendApproved", () => {
		it("creates the store directory if missing", () => {
			// when
			appendApproved(agentDir, projectDir, [ALLOW_BASH]);

			// then
			expect(fs.existsSync(path.dirname(approvedStorePath(agentDir, projectDir)))).toBe(true);
		});

		it("appends rules as JSONL lines stamped with the source marker", () => {
			// when
			appendApproved(agentDir, projectDir, [ALLOW_BASH, ALLOW_READ]);

			// then
			const content = fs.readFileSync(approvedStorePath(agentDir, projectDir), "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0])).toEqual({ ...ALLOW_BASH, source: "user-answer" });
			expect(JSON.parse(lines[1])).toEqual({ ...ALLOW_READ, source: "user-answer" });
		});

		it("handles multiple appends correctly", () => {
			// when
			appendApproved(agentDir, projectDir, [ALLOW_BASH]);
			appendApproved(agentDir, projectDir, [ALLOW_READ]);

			// then
			expect(loadApproved(agentDir, projectDir)).toEqual([ALLOW_BASH, ALLOW_READ]);
		});

		it("does nothing when rules array is empty", () => {
			// when
			appendApproved(agentDir, projectDir, []);

			// then
			expect(fs.existsSync(approvedStorePath(agentDir, projectDir))).toBe(false);
		});
	});

	describe("clearApproved", () => {
		it("deletes the store file", () => {
			// given
			appendApproved(agentDir, projectDir, [ALLOW_BASH]);
			const storePath = approvedStorePath(agentDir, projectDir);
			expect(fs.existsSync(storePath)).toBe(true);

			// when
			clearApproved(agentDir, projectDir);

			// then
			expect(fs.existsSync(storePath)).toBe(false);
		});

		it("does not throw when the store does not exist", () => {
			// when/then
			expect(() => clearApproved(agentDir, projectDir)).not.toThrow();
		});
	});

	describe("compactApproved", () => {
		it("removes duplicate rules keeping the last occurrence", () => {
			// given
			appendApproved(agentDir, projectDir, [
				ALLOW_BASH,
				{ permission: "bash", pattern: "git *", action: "allow" },
				ALLOW_READ,
			]);

			// when
			compactApproved(agentDir, projectDir);

			// then
			expect(loadApproved(agentDir, projectDir)).toEqual([ALLOW_BASH, ALLOW_READ]);
		});

		it("keeps rules with different permissions but the same pattern", () => {
			// given
			appendApproved(agentDir, projectDir, [{ permission: "bash", pattern: "*", action: "allow" }, ALLOW_READ]);

			// when
			compactApproved(agentDir, projectDir);

			// then
			const result = loadApproved(agentDir, projectDir);
			expect(result).toContainEqual({ permission: "bash", pattern: "*", action: "allow" });
			expect(result).toContainEqual(ALLOW_READ);
		});

		it("does nothing when the store does not exist", () => {
			// when/then
			expect(() => compactApproved(agentDir, projectDir)).not.toThrow();
		});
	});

	describe("round-trip", () => {
		it("writes and reads back rules correctly", () => {
			// when
			appendApproved(agentDir, projectDir, [ALLOW_BASH, ALLOW_READ]);
			const loaded = loadApproved(agentDir, projectDir);

			// then
			expect(loaded).toEqual([ALLOW_BASH, ALLOW_READ]);
		});
	});
});
