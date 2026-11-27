import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { engine, ENGINE_COMMANDS, GATED_SLICE } from "../../src/engine/index.ts";

/** The leaves of design #14944 section 6.8 that carry no credential (slice E1a), after amendment 1. */
const E1A_LEAVES = [
	"packages.install",
	"packages.remove",
	"packages.list",
	"packages.update",
	"models.update",
	"models.discover",
	"models.list",
	"config.agentDir",
	"config.resources",
	"config.setResource",
	"schedule.list",
	"schedule.cancel",
	"schedule.run",
	"sessionOfPid",
	"sessions.exportHtml",
	"promptSizes",
	"tips",
	"host.ensure",
	"host.status",
	"host.stop",
	"host.handoff",
	"host.gc",
	"host.shardPath",
].sort();

function exportedLeaves(value: unknown, prefix = ""): string[] {
	if (typeof value === "function") return [prefix];
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([key, member]) => exportedLeaves(member, prefix ? `${prefix}.${key}` : key));
}

describe("the exported leaves, the metadata and the design's leaf set are the same set (review M5)", () => {
	it("exports exactly the 23 leaves", () => {
		expect(exportedLeaves(engine).sort()).toEqual(E1A_LEAVES);
	});

	it("describes exactly the 23 leaves in the command metadata", () => {
		expect([...new Set(ENGINE_COMMANDS.map((command) => command.call))].sort()).toEqual(E1A_LEAVES);
	});

	it("marks the resource-setting leaf as performed by the config TUI", () => {
		expect(ENGINE_COMMANDS.filter((command) => command.call === "config.setResource")).toEqual([
			expect.objectContaining({ argv: ["config"], via: "tui" }),
		]);
	});
});

describe("the exported surface takes no gated input (E1a-s)", () => {
	it("ignores an endpoint, key root or presenter channel passed to a host function", async () => {
		const smuggled = {
			kind: "p",
			owner: "x",
			socket: "/tmp/evil.sock",
			keyRoot: "/tmp",
			key_root: "/tmp",
			presenterBootstrapFd: 4,
		} as const;
		const shard = await engine.host.shardPath(smuggled);
		expect(shard.kind === "ok" && shard.value.payload.socket).toBe(
			join(getAgentDir(), "rpc", "shards", "p-945b87278a044a9c.sock"),
		);
		const status = await engine.host.status({ socket: "/tmp/evil.sock" } as never);
		expect(status.kind === "error" && status.error.details?.payload).toMatchObject({
			socket: join(getAgentDir(), "rpc", "rpc.sock"),
		});
	});

	it("records every endpoint, key-root, presenter and launch-setup flag as an E1a-s gap, never as an input", () => {
		const gatedPrefixes = ["endpoint.", "presenter.", "setup."];
		for (const command of ENGINE_COMMANDS) {
			for (const flag of command.flags) {
				const name = flag.names[0] ?? "";
				const gatedFlag =
					["--socket", "--rpc-key-root", "--mcp-presenter-fd", "--mcp-presenter-enforcement"].includes(name) ||
					(["models.list", "promptSizes"].includes(command.call) && !flag.required);
				const { mapping } = flag;
				if (gatedFlag)
					expect(mapping, `${command.call} ${name}`).toMatchObject({ kind: "gated", slice: GATED_SLICE });
				if (mapping.kind === "gated")
					expect(gatedPrefixes.some((prefix) => mapping.field.startsWith(prefix))).toBe(true);
				if (mapping.kind === "input")
					expect(gatedPrefixes.some((prefix) => mapping.field.startsWith(prefix))).toBe(false);
			}
		}
	});
});
