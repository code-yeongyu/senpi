import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { registerMcpCommands } from "../../../src/core/extensions/builtin/mcp/commands.ts";
import { McpManagerView } from "../../../src/core/extensions/builtin/mcp/manager-view.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createUi } from "../../mcp/fixtures/commands.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer } from "../../mcp/fixtures/service-lifecycle.ts";
import { waitForSignalBeforeCompletion } from "../../promise-test-utils.ts";
import { createHarness } from "../harness.ts";

const cleanup: Array<() => Promise<void>> = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];
const names = [String.raw`path\tools\n`, "control\t\n\r\b\f\0\x1b"] as const;
const url = "https://dispatch.example.invalid/mcp";

beforeEach(() => initTheme("dark"));

afterEach(async () => {
	vi.restoreAllMocks();
	await cleanupRoots(cleanup);
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
});

async function setup(name: string, oauth = false) {
	const root = makeRoot("manager-dispatch", cleanup);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	setConfig(root, {
		[name]: oauth
			? { type: "http", url, auth: "oauth", enabled: false }
			: { ...stdioServer(["--tools", "1"]), auth: false },
	});
	const service = new McpService();
	cleanup.push(() => service.dispose("quit"));
	const command: { pi?: ExtensionAPI } = {};
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				command.pi = pi;
				registerMcpCommands(pi, service);
			},
		],
	});
	cleanup.push(async () => harness.cleanup());
	const ui = createUi();
	const tui = new TUI(new VirtualTerminal(120, 36));
	tui.requestRender = () => {};
	cleanup.push(async () => tui.stop());
	ui.custom = async <T>(factory: Parameters<typeof ui.custom<T>>[0]): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			let view: Awaited<ReturnType<typeof factory>> | undefined;
			Promise.resolve(
				factory(tui, theme, new KeybindingsManager(), (value) => {
					view?.dispose?.();
					resolve(value);
				}),
			).then((component) => {
				view = component;
			}, reject);
		});
	await harness.session.bindExtensions({ uiContext: ui, mode: "tui" });
	const pi = command.pi;
	if (pi === undefined) throw new Error("The /mcp command extension never loaded");
	// The session attaches through the API its /mcp command runs with, as the MCP builtin does (senpi#3001).
	await service.attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root.cwd, isProjectTrusted: () => true },
		pi,
		{ agentDir: root.agentDir },
	);
	expect(await service.whenAttachSettled()).toBe("settled");
	return { root, service, harness, ui, pi };
}

// senpi#2716, PR #2747: exercise the registered slash command and real manager,
// replacing only menu input and network operations, never the dispatch callback.
describe("MCP manager structured dispatch", () => {
	it("retains the original guarded context through gated reconnect, rebinding, invalidation, and release", async () => {
		// senpi#2716, PR #2747 owner item 2: observe the registered command and
		// real service attach, not a copied context or a mocked attach result.
		const name = "owner-context";
		const { root, service, harness, ui } = await setup(name);
		const initialPid = service.getConnection(name)?.getRootPid();
		if (!initialPid) throw new Error("Initial fixture did not spawn");
		const runner = harness.getExtensionRunner();
		const createContext = vi.spyOn(runner, "createCommandContext");
		const attachSession = service.attachSession.bind(service);
		const bindings: Array<{
			ctx: Parameters<typeof service.attachSession>[1];
			pi: NonNullable<Parameters<typeof service.attachSession>[2]>;
		}> = [];
		vi.spyOn(service, "attachSession").mockImplementation(async (event, ctx, pi, options) => {
			await attachSession(event, ctx, pi, options);
			if (!pi) throw new Error("Reconnect did not attach its extension API");
			bindings.push({ ctx, pi });
		});
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const reconnectServer = service.reconnectServer.bind(service);
		vi.spyOn(service, "reconnectServer").mockImplementation(async (server) => {
			entered.resolve();
			await resume.promise;
			await reconnectServer(server);
		});
		const choices: Array<string | undefined> = [name, "test", "reconnect", undefined, undefined];
		const details: string[] = [];
		vi.spyOn(McpManagerView.prototype, "menu").mockImplementation(async (build) => {
			const menu = await build();
			if (menu.details) details.push(menu.details);
			const choice = choices.shift();
			if (choice === undefined) return undefined;
			expect(menu.items.some((item) => item.value === choice)).toBe(true);
			return choice;
		});
		const notify = ui.notify;
		const reboundUi = createUi();
		const deadline = setTimeout(() => entered.reject(new Error("Reconnect did not enter its gate")), 2000);
		const operation = harness.session.prompt("/mcp");
		try {
			await waitForSignalBeforeCompletion(operation, entered.promise, "reconnect gate");
			clearTimeout(deadline);
			const original = createContext.mock.results[0]?.value;
			if (!original) throw new Error("Registered command did not create a runner context");
			expect(original.mode).toBe("tui");
			const originalUi = original.ui;
			runner.setUIContext(reboundUi, "print");
			expect(original.mode).toBe("print");
			expect(original.ui).not.toBe(originalUi);
			resume.resolve();
			await operation;
			const binding = bindings[0];
			if (!binding) throw new Error("Reconnect did not finish its real service attach");

			expect(binding.ctx).toBe(original);
			expect(binding.ctx.mode).toBe("print");
			expect(binding.ctx.sessionManager).toBe(harness.sessionManager);
			expect(ui.notify).toBe(notify);
			expect(ui.notifications).toEqual([]);
			expect(reboundUi.notifications).toEqual([]);
			expect(details.some((text) => /^MCP test owner-context ok \(\d+ms\): 1 tools$/.test(text))).toBe(true);
			expect(details).toContain(`MCP reconnect ${name} connected`);
			expect(service.getConnection(name)?.state).toBe("connected");
			expect(binding.pi.getActiveTools()).toContain("mcp_owner-context_tool_1");
			const reconnectPid = service.getConnection(name)?.getRootPid();
			if (!reconnectPid) throw new Error("Reconnect fixture did not spawn");

			runner.invalidate();
			expect(() => binding.ctx.mode).toThrow("This extension ctx is stale");
			expect(() => binding.ctx.sessionManager).toThrow("This extension ctx is stale");
			await service.releaseSession({}, "quit");
			expect(service.isDisposed()).toBe(false);
			await service.releaseSession(binding.pi, "quit");
			expect(service.getSnapshot()).toMatchObject({
				disposed: true,
				disposeCount: 1,
				lastDisposeReason: "quit",
				hasSessionContext: false,
				connectionCount: 0,
			});
			expect(service.getConnection(name)).toBeUndefined();
			for (const pid of new Set([initialPid, reconnectPid])) {
				expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
			}
			console.info(
				"owner-context: original identity; live mode=print; stale mode/sessionManager throw; exact pi release disposes; both fixture PIDs reaped",
			);
		} finally {
			clearTimeout(deadline);
			resume.resolve();
			await operation;
			vi.restoreAllMocks();
			await cleanupRoots(cleanup);
			expect(existsSync(dirname(root.agentDir))).toBe(false);
			expect(existsSync(harness.tempDir)).toBe(false);
			console.info(
				"owner-context cleanup: gate resumed; deadline cleared; command joined; mocks restored; TUI stopped; harness/provider disposed; service disposed; temporary roots removed",
			);
		}
	});

	for (const action of ["test", "reconnect", "auth", "logout"] as const) {
		it.each(names)(`preserves raw server identity when the manager selects ${action}: %j`, async (name) => {
			// Given: a configured server whose identity JSON encoding would change.
			const oauth = action === "auth" || action === "logout";
			const { root, service, harness } = await setup(name, oauth);
			const reconnect = vi.spyOn(service, "reconnectServer");
			if (oauth) {
				// Supply OAuth menu states without contacting an external authorization server.
				const snapshots = service.getServerSnapshots();
				vi.spyOn(service, "getServerSnapshots").mockImplementation(() =>
					snapshots.map((snapshot) => ({
						...snapshot,
						configState: "enabled",
						lifecycleState: action === "logout" ? "connected" : "needs_auth",
					})),
				);
				reconnect.mockResolvedValue();
				vi.spyOn(service, "attachSession").mockResolvedValue();
				vi.spyOn(service, "getServerAuthStatus").mockReturnValue(action === "logout" ? "oAuth" : "notLoggedIn");
			}
			const beginAuth = vi.spyOn(service, "beginInteractiveAuth");
			if (action === "auth") service.beginInteractiveAuth(name);
			beginAuth.mockClear();
			const store = new McpTokenStore({ serverName: name, serverUrl: url, agentDir: root.agentDir });
			if (action === "logout") await store.update(() => ({ accessToken: "fake-dispatch-token" }));
			const choices: Array<string | undefined> = [name, action, undefined, undefined];
			const details: string[] = [];
			vi.spyOn(McpManagerView.prototype, "menu").mockImplementation(async (build) => {
				const menu = await build();
				if (menu.details) details.push(menu.details);
				const choice = choices.shift();
				if (choice === undefined) return undefined;
				const selected = menu.items.find((item) => item.value === choice);
				expect(selected).toBeDefined();
				return selected?.value;
			});

			// When: /mcp opens the real manager and the menu selects the action.
			await harness.session.prompt("/mcp");

			// Then: the existing handler operates on the original identity.
			switch (action) {
				case "test":
					expect(service.getServerSnapshots().find((snapshot) => snapshot.name === name)?.counters.callCount).toBe(
						1,
					);
					expect(details.some((text) => text.includes("Unknown MCP server:"))).toBe(false);
					break;
				case "reconnect":
					expect(reconnect).toHaveBeenCalledExactlyOnceWith(name);
					break;
				case "auth":
					expect(beginAuth).toHaveBeenCalledExactlyOnceWith(name);
					break;
				case "logout":
					expect(store.read()).toBeUndefined();
					expect(reconnect).toHaveBeenCalledExactlyOnceWith(name);
					break;
				default:
					throw new Error(`Unexpected manager action: ${action satisfies never}`);
			}
		});
	}

	it.each([
		{ name: String.raw`path\tools\n`, args: String.raw`logs "path\tools\n"` },
		{ name: 'quote"server', args: String.raw`logs "quote\"server"` },
		{ name: "space server", args: "logs 'space server'" },
	])("preserves existing CLI parsing when given $args", async ({ name, args }) => {
		// Given: a real registered command with a known server.
		const { service, harness, pi } = await setup(name, true);
		const logs = vi.spyOn(service, "getLogLines");
		// When: a textual subcommand uses the existing quoting/escaping syntax.
		await harness.session.prompt(`/mcp ${args}`);
		// Then: parsing still resolves the same server identity.
		expect(logs).toHaveBeenCalledExactlyOnceWith(name, 20, pi);
	});
});
