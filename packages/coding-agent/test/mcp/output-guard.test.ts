import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { applyMcpOutputGuard } from "../../src/core/extensions/builtin/mcp/guard/output-guard.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import {
	attach,
	awaitMcpToolRegistration,
	capturingPi,
	mcpRoot as makeMcpRoot,
	registeredTool,
	testContext,
	textContent,
} from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
let previousAgentDir: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env[ENV_AGENT_DIR];
	resetMcpServiceForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	if (previousAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = previousAgentDir;
	}
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string) {
	const root = makeMcpRoot(`output-guard-${slug}`, cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	return root;
}

describe("MCP output guard", () => {
	it("spills a 1MB text result and returns a bounded preview with the readable file path", async () => {
		const root = mcpRoot("huge-text");
		setConfig(root, { fx: stdioServer(["--tools", "0", "--huge-output-tool", "1048576/4096"]) });
		const pi = capturingPi();
		await attach(root, pi);
		await awaitMcpToolRegistration("fx");

		const result = await registeredTool(pi, "mcp_fx_huge_output_tool").execute(
			"tc-huge",
			{},
			undefined,
			undefined,
			testContext(),
		);

		const preview = textContent(result);
		const spillPath = extractSpillPath(preview);
		expect(spillPath.startsWith(join(root.agentDir, "tmp", "mcp-out"))).toBe(true);
		expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(51_200);
		expect(lineCount(preview)).toBeLessThanOrEqual(2_000);
		expect(await readFile(spillPath, "utf8")).toBe(hugeOutput(1_048_576, 4096));
		expect((await stat(spillPath)).mode & 0o777).toBe(0o600);
		expect(preview).toContain("Read the file in chunks");
	});

	it("passes under-limit text through byte-identically", async () => {
		const root = mcpRoot("small");
		setConfig(root, { fx: stdioServer(["--tools", "1"]) });
		const pi = capturingPi();
		await attach(root, pi);
		await awaitMcpToolRegistration("fx");

		const result = await registeredTool(pi, "mcp_fx_tool_1").execute(
			"tc-small",
			{ value: "ok" },
			undefined,
			undefined,
			testContext(),
		);

		expect(textContent(result)).toBe("fixture tool_1 value=ok mode=alpha");
		expect(existsSync(join(root.agentDir, "tmp", "mcp-out"))).toBe(false);
	});

	it("spills binary image output with a mime-derived extension", async () => {
		mcpRoot("binary");

		const result = await applyMcpOutputGuard(
			[{ type: "image", data: Buffer.alloc(65_536, 0x89).toString("base64"), mimeType: "image/png" }],
			{ server: "fx" },
		);

		const preview = result[0]?.type === "text" ? result[0].text : "";
		const spillPath = extractSpillPath(preview);
		expect(spillPath.endsWith(".png")).toBe(true);
		expect(readFileSync(spillPath)).toEqual(Buffer.alloc(65_536, 0x89));
		expect(preview).toContain("image/png binary output");
	});

	it("uses unique filenames for concurrent spills", async () => {
		const root = mcpRoot("concurrent");
		setConfig(root, { fx: stdioServer(["--tools", "0", "--huge-output-tool", "65536/256"]) });
		const pi = capturingPi();
		await attach(root, pi);
		await awaitMcpToolRegistration("fx");
		const tool = registeredTool(pi, "mcp_fx_huge_output_tool");

		const [first, second] = await Promise.all([
			tool.execute("tc-concurrent-1", {}, undefined, undefined, testContext()),
			tool.execute("tc-concurrent-2", {}, undefined, undefined, testContext()),
		]);
		const firstPath = extractSpillPath(textContent(first));
		const secondPath = extractSpillPath(textContent(second));

		expect(firstPath).not.toBe(secondPath);
		expect(await readFile(firstPath, "utf8")).toBe(hugeOutput(65_536, 256));
		expect(await readFile(secondPath, "utf8")).toBe(hugeOutput(65_536, 256));
	});

	it("removes spill artifacts when the MCP service is disposed", async () => {
		const root = mcpRoot("cleanup");
		setConfig(root, { fx: stdioServer(["--tools", "0", "--huge-output-tool", "65536/256"]) });
		const pi = capturingPi();
		await attach(root, pi);
		await awaitMcpToolRegistration("fx");

		const result = await registeredTool(pi, "mcp_fx_huge_output_tool").execute(
			"tc-cleanup",
			{},
			undefined,
			undefined,
			testContext(),
		);
		const spillPath = extractSpillPath(textContent(result));
		expect(existsSync(spillPath)).toBe(true);

		await getMcpService().dispose("quit");

		expect(existsSync(spillPath)).toBe(false);
	});

	it("does not silently spill isError results", async () => {
		const root = mcpRoot("iserror");
		writeFileSync(
			join(root.agentDir, "mcp.json"),
			`${JSON.stringify(
				{
					settings: { outputGuard: { maxBytes: 1, maxLines: 1 } },
					mcpServers: { fx: stdioServer(["--tools", "0", "--iserror-tool"]) },
				},
				null,
				2,
			)}\n`,
		);
		const pi = capturingPi();
		await attach(root, pi);
		await awaitMcpToolRegistration("fx");

		await expect(
			registeredTool(pi, "mcp_fx_iserror_tool").execute("tc-error", {}, undefined, undefined, testContext()),
		).rejects.toThrow();
		expect(existsSync(join(root.agentDir, "tmp", "mcp-out"))).toBe(false);
	});

	it("falls back to an inline truncated preview with a warning when tmp output cannot be written", async () => {
		const root = mcpRoot("unwritable");
		mkdirSync(root.agentDir, { recursive: true });
		writeFileSync(join(root.agentDir, "tmp"), "not a directory");
		setConfig(root, { fx: stdioServer(["--tools", "0", "--huge-output-tool", "65536/256"]) });
		const pi = capturingPi();
		await attach(root, pi);
		await awaitMcpToolRegistration("fx");

		const result = await registeredTool(pi, "mcp_fx_huge_output_tool").execute(
			"tc-unwritable",
			{},
			undefined,
			undefined,
			testContext(),
		);

		const preview = textContent(result);
		expect(preview).toContain("Warning: failed to write MCP output spill file");
		expect(preview).toContain("MCP output truncated inline");
		await expect(readdir(join(root.agentDir, "tmp", "mcp-out"))).rejects.toThrow();
	});
});

function extractSpillPath(text: string): string {
	const match = text.match(/Full output saved to: (.+)/);
	if (!match) throw new Error(`missing spill path in preview: ${text.slice(0, 500)}`);
	return match[1]?.trim() ?? "";
}

function lineCount(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

function hugeOutput(bytes: number, lines: number): string {
	const lineCount = Math.max(1, lines);
	const line = "x".repeat(Math.max(1, Math.floor(bytes / lineCount)));
	return Array.from({ length: lineCount }, () => line)
		.join("\n")
		.slice(0, bytes);
}
