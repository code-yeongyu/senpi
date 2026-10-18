import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	closeLiveHosts,
	createLiveHost,
	editInside,
	FIXTURE_TOOLS,
	readInside,
	SHELL_FIXTURE_INPUT,
	writeInside,
	writeOutside,
} from "./live-permission-host.ts";

afterEach(closeLiveHosts);

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

async function localWebServer(): Promise<string> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("probe-2465-ok");
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}/probe`;
}

describe("2465 1c: sessions opened directly with full-access", () => {
	it("1c: no tool kind asks under direct full-access (shell, read/write/edit, external, web, browser, mcp, task)", async () => {
		// given a session opened directly with the full-access preset and a local web server
		const host = await createLiveHost({ preset: "full-access" });
		await host.bind();
		writeFileSync(join(host.cwd, "probe-read.txt"), "probe");
		const url = await localWebServer();

		// when every directly gated tool kind runs
		await host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "shell");
		await host.runProbe("read", readInside(host), "read inside project");
		await host.runProbe("write", writeInside(host), "write inside project");
		await host.runProbe("edit", editInside(host), "edit inside project");
		await host.runProbe("write", writeOutside(), "write outside project");
		await host.runProbe("webfetch", { url }, "web fetch");
		await host.runProbe("browser", FIXTURE_TOOLS[1].input, "browser");
		await host.runProbe("mcp_fixture", FIXTURE_TOOLS[2].input, "mcp");
		await host.runProbe("task", FIXTURE_TOOLS[0].input, "task");

		// then nothing asked, and every call reached its tool
		expect(host.prompts()).toBe(0);
		expect(host.toolResultIsError("shell_fixture")).toBe(false);
		expect(host.toolResultIsError("read")).toBe(false);
		expect(host.toolResultText("webfetch")).toContain("probe-2465-ok");
		expect(host.toolResultIsError("browser")).toBe(false);
		expect(host.toolResultIsError("mcp_fixture")).toBe(false);
		expect(host.toolResultIsError("task")).toBe(false);
	}, 60_000);

	it("1c-baseline: the same kinds still ask under the ask preset, so the matrix can fail", async () => {
		// given a session opened with the ask preset
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();

		// when each kind runs, each raises a permission prompt
		const probes: Array<readonly [string, Record<string, unknown>]> = [
			["shell_fixture", SHELL_FIXTURE_INPUT],
			["browser", FIXTURE_TOOLS[1].input],
			["mcp_fixture", FIXTURE_TOOLS[2].input],
			["task", FIXTURE_TOOLS[0].input],
		];
		let prompted = 0;
		for (const [toolName, input] of probes) {
			const turn = host.runProbe(toolName, input, `${toolName} probe`);
			const prompt = await host.waitForPrompt();
			prompted += 1;
			prompt.resolve("Allow once");
			await turn;
		}

		// then every kind prompted
		expect(prompted).toBe(probes.length);
		expect(host.prompts()).toBe(probes.length);
	}, 60_000);
});
