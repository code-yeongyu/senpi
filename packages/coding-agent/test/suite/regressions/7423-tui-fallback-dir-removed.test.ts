import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	registerTuiEndpoint,
	resolveTuiSocket,
	unregisterTuiEndpoint,
	unregisterTuiEndpointSync,
} from "../../../src/modes/interactive/session-control-registry.ts";

// A deep agent directory puts every terminal's control socket in one shared `<tmpdir>/senpi-rpc-<8hex>/` (#3064,
// #3758). The last terminal to leave must take that directory with it, and an earlier one must not pull it out from
// under a terminal still using it (#7423).
let base: string;

beforeEach(async () => {
	// A short temp root, so the deep agent directory below falls back into it on every host.
	base = await mkdtemp("/tmp/senpi-7423-");
	vi.stubEnv("TMPDIR", base);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(base, { recursive: true, force: true });
});

async function openTerminal(agentDir: string) {
	const instanceId = crypto.randomUUID();
	const socket = await resolveTuiSocket(agentDir, instanceId);
	return { socket, entry: await registerTuiEndpoint({ agentDir, socket, instanceId }) };
}

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(
		() => true,
		() => false,
	);
}

it.skipIf(process.platform === "win32")(
	"removes the shared fallback directory when its last terminal exits, not before (#7423)",
	async () => {
		const agentDir = join(base, "agent", "deep-".repeat(40));
		const first = await openTerminal(agentDir);
		const second = await openTerminal(agentDir);
		const directory = dirname(first.socket);
		expect(dirname(second.socket)).toBe(directory);
		expect(directory.startsWith(`${base}/senpi-rpc-`)).toBe(true);

		await unregisterTuiEndpoint(first.entry);
		expect(await exists(directory)).toBe(true);
		expect(await readdir(directory)).toHaveLength(1);

		await unregisterTuiEndpoint(second.entry);
		expect(await exists(directory)).toBe(false);
	},
);

it.skipIf(process.platform === "win32")(
	"the synchronous exit path removes an emptied fallback directory too (#7423)",
	async () => {
		const terminal = await openTerminal(join(base, "agent", "deep-".repeat(40)));

		unregisterTuiEndpointSync(terminal.entry);

		expect(await exists(dirname(terminal.socket))).toBe(false);
	},
);

it.skipIf(process.platform === "win32")(
	"never removes a symlinked fallback root or the private directory it points at",
	async () => {
		const agentDir = join(base, "agent", "deep-".repeat(40));
		const target = join(base, "target");
		await mkdir(target, { mode: 0o700 });
		const link = join(base, `senpi-rpc-${createHash("sha256").update(agentDir).digest("hex").slice(0, 8)}`);
		await symlink(target, link);
		const terminal = await openTerminal(agentDir);
		expect(dirname(terminal.socket)).toBe(link);

		await unregisterTuiEndpoint(terminal.entry);
		unregisterTuiEndpointSync(terminal.entry);

		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect((await lstat(target)).isDirectory()).toBe(true);
	},
);

it.skipIf(process.platform === "win32")("never removes the primary socket directory under the agent dir", async () => {
	const agentDir = join(base, "a");
	const terminal = await openTerminal(agentDir);
	expect(dirname(terminal.socket)).toBe(join(agentDir, "rpc", "tui"));

	await unregisterTuiEndpoint(terminal.entry);

	expect(await exists(join(agentDir, "rpc", "tui"))).toBe(true);
});
