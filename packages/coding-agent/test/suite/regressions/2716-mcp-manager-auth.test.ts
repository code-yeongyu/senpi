import { join } from "node:path";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { type McpStoredAuth, McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { ServerConnection, type ServerConnectionState } from "../../../src/core/extensions/builtin/mcp/connection.ts";
import { showMcpManager } from "../../../src/core/extensions/builtin/mcp/manager.ts";
import { McpManagerView } from "../../../src/core/extensions/builtin/mcp/manager-view.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createUi } from "../../mcp/fixtures/commands.ts";
import { cleanupRoots, makeRoot, setConfig } from "../../mcp/fixtures/service-lifecycle.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanup: Array<() => Promise<void>> = [];
const serverUrl = "https://mcp.example.invalid/public";

beforeEach(() => initTheme("dark"));
afterEach(async () => {
	await cleanupRoots(cleanup);
	vi.restoreAllMocks();
});

// senpi#2716 / PR #2747: transport health is independent of stored OAuth tokens.
describe("MCP manager OAuth actions", () => {
	it.each([
		{ state: "idle", record: { accessToken: "fake-access" }, command: "logout" },
		{ state: "degraded", record: { accessToken: "fake-access" }, command: "logout" },
		{ state: "needs_auth", record: { accessToken: "fake-access", expiresAt: 0 }, command: "logout" },
		{ state: "connected", record: undefined, command: "auth" },
		{ state: "connected", record: { clientInfo: { client_id: "fake-client", redirect_uris: [] } }, command: "auth" },
		{ state: "connected", record: { accessToken: "fake-access" }, command: "logout" },
		{ state: "degraded", record: undefined, command: "auth" },
	] satisfies Array<{
		state: ServerConnectionState;
		record: McpStoredAuth | undefined;
		command: "auth" | "logout";
	}>)("dispatches $command when $state with record $record", async ({ state, record, command }) => {
		// Given: a real service/provider and isolated store, with only transport IO replaced.
		const root = makeRoot("manager-auth", cleanup);
		setConfig(root, { fx: { type: "http", url: serverUrl, lifecycle: "lazy" } });
		vi.spyOn(ServerConnection.prototype, "connect").mockRejectedValue(new Error("offline fixture"));
		const service = new McpService();
		let harness: Harness | undefined;
		cleanup.push(async () => {
			harness?.cleanup();
			await service.dispose("quit");
		});
		const store = new McpTokenStore({ agentDir: root.agentDir, serverName: "fx", serverUrl });
		// Bind the transport to this fixture's principal, not credentials changed after attachment.
		// No record has a refresh token, so an expired record cannot initiate remote refresh IO.
		if (record !== undefined) await store.write(record);
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			undefined,
			{ agentDir: root.agentDir, logDir: join(root.agentDir, "logs"), env: {} },
		);
		expect(await service.whenAttachSettled(10_000)).toBe("settled");
		const connection = service.getConnection("fx");
		if (connection === undefined) throw new Error("fixture connection missing");
		vi.spyOn(connection, "state", "get").mockReturnValue(state);
		vi.spyOn(service, "getServerExposureStatus").mockResolvedValue({ toolCount: 0 });
		const run = vi.fn(async () => {});
		let menus = 0;
		let authActions: string[] = [];
		vi.spyOn(McpManagerView.prototype, "menu").mockImplementation(async (build) => {
			const menu = await build();
			menus++;
			if (menus === 1) return "fx";
			authActions = menu.items
				.filter((item) => item.value === "auth" || item.value === "logout")
				.map((item) => item.value);
			return authActions[0];
		});
		const ui = createUi();
		const tui = new TUI(new VirtualTerminal(120, 36));
		ui.custom = async <T>(factory: Parameters<typeof ui.custom<T>>[0]): Promise<T> =>
			new Promise<T>((resolve, reject) => {
				Promise.resolve(factory(tui, theme, new KeybindingsManager(), resolve)).catch(reject);
			});
		cleanup.push(async () => tui.stop());
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("auth-menu-test", {
						description: "Exercise the MCP manager",
						handler: (_args, ctx) => showMcpManager(ctx, pi, service, run),
					});
				},
			],
		});
		await harness.session.bindExtensions({ uiContext: ui, mode: "tui" });

		// When: the manager opens this server and selects its offered auth action.
		await harness.session.prompt("/auth-menu-test");

		// Then: exactly the credential-appropriate command leaves the custom view.
		expect(authActions).toEqual([command]);
		expect(run).toHaveBeenCalledExactlyOnceWith(command, "fx", expect.anything());
		expect(ui.notifications).toEqual([]);
	});
});
