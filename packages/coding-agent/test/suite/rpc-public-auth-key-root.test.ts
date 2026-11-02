import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHostArgs, runHostCommand } from "../../src/cli/host-command.ts";
import { getAgentDir } from "../../src/config.ts";
import { runHostRequest } from "../../src/modes/rpc/host-runner.ts";
import { rpcKeyRoot, withRpcKeyRoot } from "../../src/modes/rpc/rpc-auth-client.ts";

// The gc pass and the status read are replaced, and the command's JSON answer is captured: these tests observe which
// key root is in effect when `senpi host` reaches them.
const calls = vi.hoisted(() => ({
	gc: [] as Array<{ agentDir: string; keyRoot: string }>,
	status: [] as Array<{ agentDir: string | undefined; keyRoot: string }>,
	emitted: [] as unknown[],
}));
vi.mock("../../src/modes/rpc/host-gc.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modes/rpc/host-gc.ts")>();
	const { rpcKeyRoot: currentKeyRoot } = await import("../../src/modes/rpc/rpc-auth-client.ts");
	return {
		...actual,
		gcHostEndpoints: async (agentDir: string) => {
			calls.gc.push({ agentDir, keyRoot: currentKeyRoot() });
			return { removed: [], kept: [] };
		},
	};
});
vi.mock("../../src/modes/rpc/host-status.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modes/rpc/host-status.ts")>();
	const { rpcKeyRoot: currentKeyRoot } = await import("../../src/modes/rpc/rpc-auth-client.ts");
	return {
		...actual,
		readHostStatus: async (options: { readonly agentDir?: string }) => {
			calls.status.push({ agentDir: options.agentDir, keyRoot: currentKeyRoot() });
			return { reachable: true };
		},
	};
});
vi.mock("../../src/cli/host-emit.ts", () => ({
	emit: (payload: unknown) => {
		calls.emitted.push(payload);
	},
}));

afterEach(() => {
	vi.unstubAllEnvs();
	calls.gc.splice(0);
	calls.status.splice(0);
	calls.emitted.splice(0);
});

describe.skipIf(process.platform === "win32")("public RPC credential-root selection", () => {
	it("lets an explicit host flag override the environment without changing the profile", () => {
		vi.stubEnv("SENPI_RPC_KEY_ROOT", "/environment-root");
		const profile = getAgentDir();
		const parsed = parseHostArgs(["status", "--rpc-key-root", "/flag-root"]);
		if (typeof parsed === "string") throw new Error(parsed);
		expect(withRpcKeyRoot(parsed.keyRoot ?? "", () => rpcKeyRoot())).toBe("/flag-root");
		expect(getAgentDir()).toBe(profile);
		expect(rpcKeyRoot()).toBe("/environment-root");
	});

	it("gives explicit client options precedence over nested context and environment", () => {
		vi.stubEnv("SENPI_RPC_KEY_ROOT", "/environment-root");
		expect(withRpcKeyRoot("/flag-root", () => rpcKeyRoot({ keyRoot: "/client-root" }))).toBe("/client-root");
	});

	it("preserves separate roots across concurrent asynchronous operations", async () => {
		await Promise.all(
			["/root-a", "/root-b"].map((root) =>
				withRpcKeyRoot(root, async () => {
					await Promise.resolve();
					expect(rpcKeyRoot()).toBe(root);
				}),
			),
		);
	});

	// senpi#3815 review L3: `senpi host gc --agent-dir D` dials D's endpoints, so it proves keys from D's records; an
	// ambient root (SENPI_RPC_KEY_ROOT, the caller's own agent dir, an enclosing root) must not win over the directory
	// it was told to clean.
	it("host gc --agent-dir dials with that directory's key root, over SENPI_RPC_KEY_ROOT", async () => {
		vi.stubEnv("SENPI_RPC_KEY_ROOT", "/environment-root");
		expect(await runHostCommand(["gc", "--agent-dir", "/gc-target"])).toBe(0);
		expect(calls.gc).toEqual([{ agentDir: "/gc-target", keyRoot: "/gc-target" }]);
	});

	it("host gc --agent-dir is not overridden by an enclosing key root", async () => {
		expect(await withRpcKeyRoot("/caller", () => runHostCommand(["gc", "--agent-dir", "/gc-target"]))).toBe(0);
		expect(calls.gc).toEqual([{ agentDir: "/gc-target", keyRoot: "/gc-target" }]);
	});

	it("host gc keeps an explicit --rpc-key-root over its --agent-dir and SENPI_RPC_KEY_ROOT", async () => {
		vi.stubEnv("SENPI_RPC_KEY_ROOT", "/environment-root");
		expect(await runHostCommand(["gc", "--agent-dir", "/gc-target", "--rpc-key-root", "/flag-root"])).toBe(0);
		expect(calls.gc).toEqual([{ agentDir: "/gc-target", keyRoot: "/flag-root" }]);
	});

	// The public request API with a target whose agent dir is not the caller's profile: a status read dials that
	// target's endpoint, whose host published its record under the target's agent dir.
	it("runHostRequest status proves keys from the target's agent dir", async () => {
		// The caller's own profile is elsewhere, so a read that used the caller's dir would record a different root.
		expect(getAgentDir()).not.toBe("/target");
		await runHostRequest({
			action: "status",
			target: { socket: "/target/rpc/rpc.sock", agentDir: "/target" },
			includeWorkers: false,
			all: false,
		});
		expect(calls.status).toEqual([{ agentDir: "/target", keyRoot: "/target" }]);
	});

	// A status read dials the target's endpoint, whose host published its record under the target's agent dir (for
	// `host status` that is the caller's own); SENPI_RPC_KEY_ROOT overrides it and --rpc-key-root wins over both.
	it("host status dials a status target from the caller's chosen root, else the target's agent dir", async () => {
		const socket = ["--socket", "/target/rpc/rpc.sock"];
		expect(await runHostCommand(["status", ...socket])).toBe(0);
		vi.stubEnv("SENPI_RPC_KEY_ROOT", "/environment-root");
		expect(await runHostCommand(["status", ...socket])).toBe(0);
		expect(await runHostCommand(["status", ...socket, "--rpc-key-root", "/flag-root"])).toBe(0);
		expect(calls.status).toEqual([
			{ agentDir: getAgentDir(), keyRoot: getAgentDir() },
			{ agentDir: getAgentDir(), keyRoot: "/environment-root" },
			{ agentDir: getAgentDir(), keyRoot: "/flag-root" },
		]);
	});
});
