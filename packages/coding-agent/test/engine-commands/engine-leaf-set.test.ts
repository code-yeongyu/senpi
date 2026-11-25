import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import * as entry from "../../src/engine/index.ts";
import { engine, ENGINE_COMMANDS } from "../../src/engine/index.ts";

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
];

/** The leaves slice E1a-s adds (design 6.8 auth rows, 6.9 launch operations). */
const E1A_S_LEAVES = [
	"auth.check",
	"auth.credentials",
	"auth.apiKey",
	"auth.bearerToken",
	"launch.interactive",
	"launch.print",
	"launch.rpc",
	"launch.hand",
	"launch.headless",
];

const LEAVES = [...E1A_LEAVES, ...E1A_S_LEAVES].sort();

function exportedLeaves(value: unknown, prefix = ""): string[] {
	if (typeof value === "function") return [prefix];
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([key, member]) => exportedLeaves(member, prefix ? `${prefix}.${key}` : key));
}

describe("the exported leaves, the metadata and the design's leaf set are the same set (review M5)", () => {
	it("exports exactly the 23 leaves of E1a and the 9 of E1a-s", () => {
		expect(exportedLeaves(engine).sort()).toEqual(LEAVES);
	});

	it("describes exactly those leaves in the command metadata", () => {
		expect([...new Set(ENGINE_COMMANDS.map((command) => command.call))].sort()).toEqual(LEAVES);
	});

	it("exposes the contracts the omo root reads from the entry itself, never from an internal path", () => {
		expect(Object.keys(entry).sort()).toEqual(
			[
				"ENGINE_COMMANDS",
				"LaunchInputSchema",
				"LaunchOptionsSchema",
				"LaunchPresenterSchema",
				"LaunchSessionSchema",
				"LaunchSetupSchema",
				"RESULT_FREE_FIELDS",
				"AUTH_ACCOUNT_CHECK_CODES",
				"engine",
				"toSessionAuthStatus",
			].sort(),
		);
		expect(entry.RESULT_FREE_FIELDS.length).toBeGreaterThan(0);
	});

	it("marks the resource-setting leaf as performed by the config TUI", () => {
		expect(ENGINE_COMMANDS.filter((command) => command.call === "config.setResource")).toEqual([
			expect.objectContaining({ argv: ["config"], via: "tui" }),
		]);
	});
});

describe("the gated inputs are inputs of the exported functions (senpi#7451)", () => {
	it("passes the endpoint selector to the host core, and keeps the default endpoint without one", async () => {
		const named = await engine.host.status({ endpoint: { socket: "/tmp/e1as-named.sock" } });
		expect(named.kind === "error" && named.error.details?.payload).toMatchObject({ socket: "/tmp/e1as-named.sock" });
		const unnamed = await engine.host.status();
		expect(unnamed.kind === "error" && unnamed.error.details?.payload).toMatchObject({
			socket: join(getAgentDir(), "rpc", "rpc.sock"),
		});
	});

	it("refuses a presenter channel on any descriptor but 4, before contacting a host", async () => {
		expect(await engine.host.ensure({ presenter: { bootstrap_fd: 3 } as never })).toMatchObject({
			kind: "error",
			error: { code: "invalid_input" },
		});
	});

	it("maps every endpoint, key-root, presenter and setup flag to an input field, and the launch key to a handle", () => {
		for (const command of ENGINE_COMMANDS) {
			for (const flag of command.flags) {
				const name = flag.names[0] ?? "";
				const { mapping } = flag;
				if (["--socket", "--rpc-key-root", "--mcp-presenter-fd", "--mcp-presenter-enforcement"].includes(name)) {
					expect(mapping.kind === "input" && mapping.field, `${command.call} ${name}`).toMatch(
						/^(endpoint|presenter)\./u,
					);
				}
				if (["models.list", "promptSizes"].includes(command.call) && !flag.required) {
					expect(mapping.kind === "input" && mapping.field, `${command.call} ${name}`).toMatch(/^setup\./u);
				}
				if (name === "--api-key") expect(mapping, command.call).toEqual({ kind: "handle", field: "api_key" });
			}
		}
		for (const call of E1A_S_LEAVES.filter((leaf) => leaf.startsWith("launch."))) {
			const command = ENGINE_COMMANDS.find((entry) => entry.call === call);
			expect(
				command?.flags.some((flag) => flag.names[0] === "--api-key"),
				call,
			).toBe(true);
		}
	});
});
