import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { canonicalizeFilesystemPath, composeFilesystemPolicies } from "../src/core/tools/filesystem-policy.ts";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
	type FilesystemOperation,
	type FilesystemPolicy,
	type FilesystemPolicyChecker,
} from "../src/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const ALLOW = { allow: true } as const;

function isContained(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("extension filesystem policies", () => {
	const tempDirs: string[] = [];
	const harnesses: Harness[] = [];

	function createTempDir(prefix: string): string {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers policy objects and preserves denied-root metadata", async () => {
		const deniedRoot = createTempDir("senpi-fs-policy-denied-");
		const policy: FilesystemPolicy = {
			deniedRoots: [deniedRoot],
			check: () => ALLOW,
		};
		const extension = await loadExtensionFromFactory(
			(pi) => pi.registerFilesystemPolicy(policy),
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:filesystem-policy>",
		);

		expect(extension.filesystemPolicies).toEqual([policy]);
	});

	it("composes policies in registration order with deny winning", async () => {
		const calls: string[] = [];
		const policies: FilesystemPolicy[] = [
			{
				check: async () => {
					calls.push("allow-first");
					return ALLOW;
				},
			},
			{
				check: () => {
					calls.push("deny-second");
					return { allow: false, reason: "blocked by second policy" };
				},
			},
			{
				check: () => {
					calls.push("deny-third");
					return { allow: false, reason: "later denial" };
				},
			},
		];
		const checker = composeFilesystemPolicies(policies);

		expect(checker).toBeDefined();
		await expect(checker?.({ operation: "read", canonicalPath: process.cwd(), toolName: "read" })).resolves.toEqual({
			allow: false,
			reason: "blocked by second policy",
		});
		expect(calls).toEqual(["allow-first", "deny-second"]);
		expect(composeFilesystemPolicies([])).toBeUndefined();
	});

	it("canonicalizes existing symlinks and missing descendants through the nearest real parent", async () => {
		const root = createTempDir("senpi-fs-policy-canonical-");
		const realRoot = join(root, "real");
		const aliasRoot = join(root, "alias");
		const danglingTarget = join(root, "future-target");
		const danglingAlias = join(root, "dangling");
		mkdirSync(realRoot);
		writeFileSync(join(realRoot, "present.txt"), "present");
		symlinkSync(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
		if (process.platform !== "win32") symlinkSync(danglingTarget, danglingAlias, "dir");

		await expect(canonicalizeFilesystemPath(join(aliasRoot, "present.txt"))).resolves.toBe(
			realpathSync(join(realRoot, "present.txt")),
		);
		await expect(canonicalizeFilesystemPath(join(aliasRoot, "missing", "child.txt"))).resolves.toBe(
			resolve(realRoot, "missing", "child.txt"),
		);
		if (process.platform !== "win32") {
			await expect(canonicalizeFilesystemPath(join(danglingAlias, "child.txt"))).resolves.toBe(
				resolve(danglingTarget, "child.txt"),
			);
		}
	});

	it.each<{
		toolName: "read" | "write" | "edit" | "ls" | "find" | "grep";
		operation: FilesystemOperation;
	}>([
		{ toolName: "read", operation: "read" },
		{ toolName: "write", operation: "write" },
		{ toolName: "edit", operation: "write" },
		{ toolName: "ls", operation: "enumerate" },
		{ toolName: "find", operation: "enumerate" },
		{ toolName: "grep", operation: "enumerate" },
	])(
		"checks $toolName as $operation after canonicalization and before backend I/O",
		async ({ toolName, operation }) => {
			const root = createTempDir(`senpi-fs-policy-${toolName}-`);
			const existingFile = join(root, "present.txt");
			const missingFile = join(root, "missing.txt");
			writeFileSync(existingFile, "needle\n");
			const requests: Array<{ operation: FilesystemOperation; canonicalPath: string; toolName: string }> = [];
			const checker: FilesystemPolicyChecker = vi.fn(async (request) => {
				requests.push(request);
				return { allow: false, reason: `${toolName} denied by policy` };
			});
			const backend = {
				access: vi.fn(async () => {}),
				exists: vi.fn(async () => true),
				glob: vi.fn(async () => [existingFile]),
				isDirectory: vi.fn(async () => true),
				mkdir: vi.fn(async () => {}),
				readFile: vi.fn(async () => Buffer.from("needle\n")),
				readdir: vi.fn(async () => ["present.txt"]),
				stat: vi.fn(async () => ({ isDirectory: () => true })),
				writeFile: vi.fn(async () => {}),
			};
			let execute: () => Promise<unknown>;
			let requestedPath: string;

			switch (toolName) {
				case "read": {
					requestedPath = existingFile;
					const tool = createReadTool(root, {
						filesystemPolicy: checker,
						operations: {
							access: backend.access,
							readFile: backend.readFile,
						},
					});
					execute = () => tool.execute("read-policy", { path: requestedPath });
					break;
				}
				case "write": {
					requestedPath = missingFile;
					const tool = createWriteTool(root, {
						filesystemPolicy: checker,
						operations: { mkdir: backend.mkdir, writeFile: backend.writeFile },
					});
					execute = () => tool.execute("write-policy", { path: requestedPath, content: "blocked" });
					break;
				}
				case "edit": {
					requestedPath = existingFile;
					const tool = createEditTool(root, {
						filesystemPolicy: checker,
						operations: {
							access: backend.access,
							readFile: backend.readFile,
							writeFile: backend.writeFile,
						},
					});
					execute = () =>
						tool.execute("edit-policy", {
							path: requestedPath,
							edits: [{ oldText: "needle", newText: "replacement" }],
						});
					break;
				}
				case "ls": {
					requestedPath = root;
					const tool = createLsTool(root, {
						filesystemPolicy: checker,
						operations: { exists: backend.exists, readdir: backend.readdir, stat: backend.stat },
					});
					execute = () => tool.execute("ls-policy", { path: requestedPath });
					break;
				}
				case "find": {
					requestedPath = root;
					const tool = createFindTool(root, {
						filesystemPolicy: checker,
						operations: { exists: backend.exists, glob: backend.glob },
					});
					execute = () => tool.execute("find-policy", { path: requestedPath, pattern: "*.txt" });
					break;
				}
				case "grep": {
					requestedPath = root;
					const tool = createGrepTool(root, {
						filesystemPolicy: checker,
						operations: { isDirectory: backend.isDirectory, readFile: async () => "needle\n" },
					});
					execute = () => tool.execute("grep-policy", { path: requestedPath, pattern: "needle" });
					break;
				}
			}

			await expect(execute()).rejects.toThrow(`${toolName} denied by policy`);
			expect(requests).toEqual([
				{
					operation,
					canonicalPath: toolName === "write" ? missingFile : realpathSync(requestedPath),
					toolName,
				},
			]);
			for (const operationSpy of Object.values(backend)) {
				expect(operationSpy).not.toHaveBeenCalled();
			}
		},
	);

	it("injects registered policies into all six built-in file tools", async () => {
		let api: ExtensionAPI | undefined;
		const requests: Array<{ operation: FilesystemOperation; canonicalPath: string; toolName: string }> = [];
		const harness = await createHarness({
			initialActiveToolNames: ["read", "write", "edit", "ls", "find", "grep"],
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerFilesystemPolicy({
						check: (request) => {
							requests.push(request);
							return { allow: false, reason: `${request.toolName}:${request.operation} denied` };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const existingFile = join(harness.tempDir, "present.txt");
		const missingFile = join(harness.tempDir, "missing.txt");
		writeFileSync(existingFile, "needle\n");
		const cases = [
			{ toolName: "read", operation: "read", path: existingFile, params: { path: existingFile } },
			{ toolName: "write", operation: "write", path: missingFile, params: { path: missingFile, content: "no" } },
			{
				toolName: "edit",
				operation: "write",
				path: existingFile,
				params: { path: existingFile, edits: [{ oldText: "needle", newText: "replacement" }] },
			},
			{ toolName: "ls", operation: "enumerate", path: harness.tempDir, params: { path: harness.tempDir } },
			{
				toolName: "find",
				operation: "enumerate",
				path: harness.tempDir,
				params: { path: harness.tempDir, pattern: "*.txt" },
			},
			{
				toolName: "grep",
				operation: "enumerate",
				path: harness.tempDir,
				params: { path: harness.tempDir, pattern: "needle" },
			},
		] as const;

		for (const testCase of cases) {
			const result = await api?.executeTool(testCase.toolName, testCase.params);
			expect(textOf(result!)).toBe(`${testCase.toolName}:${testCase.operation} denied`);
		}
		expect(requests).toEqual(
			cases.map((testCase) => ({
				operation: testCase.operation,
				canonicalPath:
					testCase.toolName === "write"
						? join(realpathSync(harness.tempDir), "missing.txt")
						: realpathSync(testCase.path),
				toolName: testCase.toolName,
			})),
		);
		expect(existsSync(missingFile)).toBe(false);
	});

	it("enforces a sample extension that denies writes outside its allowed root after approval hooks", async () => {
		const allowedRoot = createTempDir("senpi-fs-policy-allowed-");
		const deniedRoot = createTempDir("senpi-fs-policy-outside-");
		let api: ExtensionAPI | undefined;
		let approvalHookCalls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("tool_call", () => {
						approvalHookCalls++;
						return { block: false };
					});
					pi.registerFilesystemPolicy({
						deniedRoots: [deniedRoot],
						check: ({ operation, canonicalPath }) => {
							if (operation !== "write" || isContained(allowedRoot, canonicalPath)) return ALLOW;
							return { allow: false, reason: "writes are limited to the extension workspace" };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const deniedPath = join(deniedRoot, "blocked.txt");
		const allowedPath = join(allowedRoot, "allowed.txt");

		expect(harness.getExtensionRunner().getFilesystemPolicyDeniedRoots()).toEqual([deniedRoot]);
		const deniedExecuteResult = await api?.executeTool("write", { path: deniedPath, content: "blocked" });
		expect(textOf(deniedExecuteResult!)).toBe("writes are limited to the extension workspace");
		expect(existsSync(deniedPath)).toBe(false);

		const allowedExecuteResult = await api?.executeTool("write", { path: allowedPath, content: "allowed" });
		expect(textOf(allowedExecuteResult!)).toContain("Successfully wrote");
		expect(existsSync(allowedPath)).toBe(true);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: deniedPath, content: "still blocked" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write outside the workspace");

		const toolResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "write",
		);
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role !== "toolResult") throw new Error("Expected write tool result");
		expect(toolResult.isError).toBe(true);
		expect(textOf(toolResult)).toBe("writes are limited to the extension workspace");
		expect(existsSync(deniedPath)).toBe(false);
		expect(approvalHookCalls).toBe(3);
	});
});
