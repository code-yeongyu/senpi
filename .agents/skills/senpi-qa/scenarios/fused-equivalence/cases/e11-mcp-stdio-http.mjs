// E11 (plan §6.4): MCP stdio + HTTP. O1-O7.
//
// Two real MCP servers from the repo's MCP fixtures (packages/coding-agent/test/mcp/fixtures): one over stdio, spawned
// by the CLI, and one over Streamable HTTP, started by the case. Both are configured in the sandbox's global mcp.json with
// the eager lifecycle, and the case waits until both report connected with their tool listed before the prompt; one model
// turn calls a tool on each. The HTTP server's origin is a run-scoped root like the sandbox.
//
// The two eager connects run in parallel, and how many `loaded_surfaces_changed` events the startup produces depends on
// which intermediate inventories the serialized wire-status captures see (2 or 3 measured at one head on one host).
// The case therefore records a settle barrier (`run.surfacesSettled`): O6 compares the settled inventory, every surfaces
// event after the barrier, and the inventory read again after the turn (collectors.mjs).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, resolveBun, track } from "../../../scripts/lib/common.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

const MCP_FIXTURES = () => join(repoRoot(), "packages", "coding-agent", "test", "mcp", "fixtures");

function startHttpFixture(run) {
	const child = spawn(resolveBun().command, [join(MCP_FIXTURES(), "http-server.ts"), "--tools", "1"], {
		cwd: repoRoot(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	track(child);
	run.cleanups.push(
		() =>
			new Promise((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) return resolve();
				child.once("close", () => resolve());
				child.kill("SIGTERM");
			}),
	);
	return new Promise((resolve, reject) => {
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk.toString();
			const line = out.split("\n").find((candidate) => candidate.startsWith("{"));
			if (line) resolve(JSON.parse(line).url);
		});
		child.once("close", (code) => reject(new Error(`MCP HTTP fixture exited ${code} before it listened`)));
	});
}

/**
 * Resolve once every configured MCP server reports connected with its tool listed, re-reading surfaces on each change
 * event (subscribed before each read, bounded by the turn timeout), and record the settle barrier: the client, its event
 * count at that point and the settled inventory. The server flushes queued events before a response, so every startup
 * event precedes the response that reads the settled inventory.
 */
async function bothConnected(run) {
	for (;;) {
		const changed = run.nextEvent((e) => e.type === "loaded_surfaces_changed");
		const surfaces = await run.send({ type: "get_loaded_surfaces" });
		const servers = surfaces.data.mcpServers ?? [];
		if (servers.length === 2 && servers.every((server) => server.status === "connected" && server.toolCount >= 1)) {
			run.surfacesSettled = { client: run.clients.length - 1, at: run.client.events.length, mcpServers: servers };
			return;
		}
		await changed;
	}
}

export default {
	id: "E11",
	title: "MCP stdio + HTTP",
	observables: WITHOUT_O8,
	spec: {
		// One MCP call per assistant turn: two unheld calls in one batch would finish in a racing order.
		turns: [
			{ toolCalls: [{ id: "call_stdio", name: "mcp_fxstdio_tool_1", args: { value: "from-stdio" } }] },
			{ toolCalls: [{ id: "call_http", name: "mcp_fxhttp_tool_1", args: { value: "from-http" } }] },
			{ text: "E11-DONE" },
		],
	},
	async drive(run) {
		const url = await startHttpFixture(run);
		const origin = new URL(url).origin;
		run.extraRoots.push(
			{ prefix: origin, token: "<mcp-http>" },
			{ prefix: origin.replace(/^http:\/\//, ""), token: "<mcp-http-host>" },
		);
		const config = {
			mcpServers: {
				fxstdio: {
					command: resolveBun().command,
					args: [join(MCP_FIXTURES(), "stdio-server.ts"), "--tools", "1"],
					lifecycle: "eager",
				},
				fxhttp: { url, lifecycle: "eager", auth: false },
			},
		};
		writeFileSync(join(run.box.agentDir, "mcp.json"), `${JSON.stringify(config, null, 2)}\n`);
		await run.open();
		await bothConnected(run);
		await run.prompt("call one tool on each MCP server");
		run.surfacesSettled.final = (await run.send({ type: "get_loaded_surfaces" })).data.mcpServers ?? [];
		await run.close();
	},
};
