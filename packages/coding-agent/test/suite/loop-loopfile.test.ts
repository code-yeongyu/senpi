import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, resolveAgentDir } from "../../src/config.ts";
import { LoopFileError, resolveLoopFile } from "../../src/core/extensions/builtin/loop/loopfile.ts";

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

interface MockFile {
	content: Buffer;
	mtimeMs: number;
}

function makeFs(files: Record<string, MockFile>) {
	return {
		stat: async (path: string): Promise<{ mtimeMs: number; size: number }> => {
			const entry = files[path];
			if (!entry) {
				const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return { mtimeMs: entry.mtimeMs, size: entry.content.length };
		},
		readFile: async (path: string): Promise<Buffer> => {
			const entry = files[path];
			if (!entry) {
				const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return entry.content;
		},
		readBytes: async (path: string, maxBytes: number): Promise<Buffer> => {
			const entry = files[path];
			if (!entry) {
				const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return entry.content.subarray(0, maxBytes);
		},
	};
}

function projectLoopPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "loop.md");
}

function agentLoopPath(cwd: string, homeDir: string): string {
	return join(resolveAgentDir(cwd, homeDir), "loop.md");
}

describe("resolveLoopFile", () => {
	it("prefers the project-level loop.md over the agent-dir loop.md", async () => {
		const cwd = "/project";
		const homeDir = "/home/user";
		const projectPath = projectLoopPath(cwd);
		const agentPath = agentLoopPath(cwd, homeDir);
		const fs = makeFs({
			[projectPath]: { content: Buffer.from("project tasks"), mtimeMs: 1000 },
			[agentPath]: { content: Buffer.from("agent tasks"), mtimeMs: 2000 },
		});

		const result = await resolveLoopFile({ cwd, homeDir, fs, path: { join } });

		expect(result.found).toBe(true);
		if (!result.found) return;
		expect(result.path).toBe(projectPath);
		expect(result.content).toBe("project tasks");
		expect(result.fingerprint.path).toBe(projectPath);
		expect(result.fingerprint.mtimeMs).toBe(1000);
		expect(result.fingerprint.size).toBe(13);
		expect(result.fingerprint.contentHash).toBe(sha256("project tasks"));
	});

	it("falls back to the agent-dir loop.md when the project file is absent", async () => {
		const cwd = "/project";
		const homeDir = "/home/user";
		const agentPath = agentLoopPath(cwd, homeDir);
		const fs = makeFs({
			[agentPath]: { content: Buffer.from("agent tasks"), mtimeMs: 2000 },
		});

		const result = await resolveLoopFile({ cwd, homeDir, fs, path: { join } });

		expect(result.found).toBe(true);
		if (!result.found) return;
		expect(result.path).toBe(agentPath);
		expect(result.content).toBe("agent tasks");
		expect(result.fingerprint.path).toBe(agentPath);
		expect(result.fingerprint.mtimeMs).toBe(2000);
		expect(result.fingerprint.size).toBe(11);
	});

	it("returns found:false when both loop.md files are absent", async () => {
		const cwd = "/project";
		const homeDir = "/home/user";
		const fs = makeFs({});

		const result = await resolveLoopFile({ cwd, homeDir, fs, path: { join } });

		expect(result.found).toBe(false);
	});

	it("truncates a 30000-byte file to at most 25000 bytes with a warning line and hashes the truncated text", async () => {
		const cwd = "/project";
		const homeDir = "/home/user";
		const projectPath = projectLoopPath(cwd);
		const longContent = "x".repeat(30000);
		const fs = makeFs({
			[projectPath]: { content: Buffer.from(longContent), mtimeMs: 1000 },
		});

		const result = await resolveLoopFile({ cwd, homeDir, fs, path: { join } });

		expect(result.found).toBe(true);
		if (!result.found) return;
		expect(result.content).toContain("[loop.md truncated to the first 25000 bytes]");
		expect(result.content.length).toBeLessThanOrEqual(
			25000 + "[loop.md truncated to the first 25000 bytes]".length + 1,
		);
		const expectedTruncated = `${longContent.slice(0, 25000)}\n[loop.md truncated to the first 25000 bytes]`;
		expect(result.content).toBe(expectedTruncated);
		expect(result.fingerprint.contentHash).toBe(sha256(expectedTruncated));
		expect(result.fingerprint.size).toBe(30000);
	});

	it("does not split a multi-byte character at the truncation boundary", async () => {
		const cwd = "/project";
		const homeDir = "/home/user";
		const projectPath = projectLoopPath(cwd);
		// 24999 single-byte chars plus one 3-byte CJK char = 25002 bytes.
		const content = `${"a".repeat(24999)}中`;
		const fs = makeFs({
			[projectPath]: { content: Buffer.from(content), mtimeMs: 1000 },
		});

		const result = await resolveLoopFile({ cwd, homeDir, fs, path: { join } });

		expect(result.found).toBe(true);
		if (!result.found) return;
		expect(result.content).not.toContain("\uFFFD");
		expect(result.content.startsWith("a".repeat(24999))).toBe(true);
		expect(result.content).toContain("[loop.md truncated to the first 25000 bytes]");
	});

	it("changes fingerprint when mtime or size changes", async () => {
		const cwd = "/project";
		const homeDir = "/home/user";
		const projectPath = projectLoopPath(cwd);
		const fs = makeFs({
			[projectPath]: { content: Buffer.from("tasks"), mtimeMs: 1000 },
		});

		const first = await resolveLoopFile({ cwd, homeDir, fs, path: { join } });
		expect(first.found).toBe(true);
		if (!first.found) return;

		// Simulate mtime change only.
		const fsMtime = makeFs({
			[projectPath]: { content: Buffer.from("tasks"), mtimeMs: 2000 },
		});
		const second = await resolveLoopFile({ cwd, homeDir, fs: fsMtime, path: { join } });
		expect(second.found).toBe(true);
		if (!second.found) return;
		expect(second.fingerprint.contentHash).toBe(first.fingerprint.contentHash);
		expect(second.fingerprint.mtimeMs).not.toBe(first.fingerprint.mtimeMs);
		expect(second.fingerprint).not.toEqual(first.fingerprint);

		// Simulate size (and therefore content/hash) change.
		const fsSize = makeFs({
			[projectPath]: { content: Buffer.from("tasks extended"), mtimeMs: 2000 },
		});
		const third = await resolveLoopFile({ cwd, homeDir, fs: fsSize, path: { join } });
		expect(third.found).toBe(true);
		if (!third.found) return;
		expect(third.fingerprint.size).not.toBe(second.fingerprint.size);
		expect(third.fingerprint.contentHash).not.toBe(second.fingerprint.contentHash);
	});

	it("surfaces a non-ENOENT stat error as a typed LoopFileError", async () => {
		const cwd = "/project";
		const homeDir = "/home/user";
		const _projectPath = projectLoopPath(cwd);
		const fs = {
			stat: async (_path: string): Promise<{ mtimeMs: number; size: number }> => {
				const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			},
			readFile: async (_path: string): Promise<Buffer> => Buffer.from(""),
			readBytes: async (_path: string, _maxBytes: number): Promise<Buffer> => Buffer.from(""),
		};

		await expect(resolveLoopFile({ cwd, homeDir, fs, path: { join } })).rejects.toThrow(LoopFileError);
		await expect(resolveLoopFile({ cwd, homeDir, fs, path: { join } })).rejects.toMatchObject({
			code: "stat_failed",
		});
	});

	it("surfaces a non-ENOENT read error as a typed LoopFileError", async () => {
		const cwd = "/project";
		const homeDir = "/home/user";
		const _projectPath = projectLoopPath(cwd);
		const fs = {
			stat: async (_path: string): Promise<{ mtimeMs: number; size: number }> => ({
				mtimeMs: 1000,
				size: 5,
			}),
			readFile: async (_path: string): Promise<Buffer> => {
				const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			},
			readBytes: async (_path: string, _maxBytes: number): Promise<Buffer> => {
				const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			},
		};

		await expect(resolveLoopFile({ cwd, homeDir, fs, path: { join } })).rejects.toThrow(LoopFileError);
		await expect(resolveLoopFile({ cwd, homeDir, fs, path: { join } })).rejects.toMatchObject({
			code: "read_failed",
		});
	});
});
