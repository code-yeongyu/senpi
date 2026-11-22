import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { registerMcpCommands } from "../../../src/core/extensions/builtin/mcp/commands.ts";
import { showMcpManager } from "../../../src/core/extensions/builtin/mcp/manager.ts";
import { type McpManagerMenu, McpManagerView } from "../../../src/core/extensions/builtin/mcp/manager-view.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import type { McpServerSnapshot } from "../../../src/core/extensions/builtin/mcp/service-types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createUi } from "../../mcp/fixtures/commands.ts";
import {
	attach,
	cleanupRoots,
	makeRoot,
	setConfig,
	stdioServer,
	writeProjectConfig,
} from "../../mcp/fixtures/service-lifecycle.ts";
import { createHarness } from "../harness.ts";

const cleanup: Array<() => Promise<void>> = [];
const writeActions = ["enable", "disable", "exposure"] as const;

beforeEach(() => initTheme("dark"));
afterEach(async () => {
	try {
		await cleanupRoots(cleanup);
	} finally {
		vi.restoreAllMocks();
	}
});

// Use the auth regression's real custom-view/menu-builder boundary. Only user
// choices are replaced; the manager supplies every captured item and detail.
function menuInput(choices: Array<string | undefined>) {
	const menus: McpManagerMenu[] = [];
	vi.spyOn(McpManagerView.prototype, "menu").mockImplementation(async (build) => {
		const menu = await build();
		menus.push(menu);
		const choice = choices.shift();
		if (choice === undefined) return undefined;
		const item = menu.items.find((candidate) => candidate.value === choice);
		if (!item) throw new Error(`Menu did not offer ${choice}`);
		return item.value;
	});
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
	return { ui, menus, choices };
}

// senpi#2716 / PR #2747: read-only provenance must not offer config writes.
// These are manager snapshot inputs, not resource-discovery/trust-loader tests.
describe("MCP manager write gate", () => {
	it.each([
		{ source: "claude", configState: "enabled" },
		{ source: "extension", configState: "enabled" },
		{ source: "skill", configState: "enabled" },
		{ source: "project", configState: "untrusted" },
	] satisfies Array<Pick<McpServerSnapshot, "source" | "configState">>)(
		"offers Details and Logs but no writes for $source/$configState",
		async ({ source, configState }) => {
			// Given: an isolated real service and the specified provenance snapshot.
			const root = makeRoot("manager-write-gate", cleanup);
			setConfig(root, { fx: { ...stdioServer([]), enabled: false } });
			const service = new McpService();
			cleanup.push(() => service.dispose("quit"));
			await attach(service, root, "startup");
			const snapshots = service.getServerSnapshots();
			vi.spyOn(service, "getServerSnapshots").mockReturnValue(
				snapshots.map((snapshot) => ({ ...snapshot, source, configState })),
			);
			const s = menuInput(["fx", undefined, undefined]);
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.registerCommand("write-gate-test", {
							description: "Exercise the MCP manager source menu",
							handler: (_args, ctx) => showMcpManager(ctx, pi, service, async () => {}),
						});
					},
				],
			});
			cleanup.push(async () => harness.cleanup());
			await harness.session.bindExtensions({ uiContext: s.ui, mode: "tui" });

			// When: the real manager builds this server's action menu.
			await harness.session.prompt("/write-gate-test");

			// Then: writes are absent without suppressing read-only inspection.
			expect(s.menus).toHaveLength(3);
			expect(s.menus[0]?.items[0]?.description).toContain(source ?? "");
			const actions = s.menus[1]?.items.map((item) => item.value);
			expect(actions).toEqual(expect.arrayContaining(["status", "logs"]));
			for (const action of writeActions) expect(actions).not.toContain(action);
			expect(s.choices).toEqual([]);
			expect(s.ui.notifications).toEqual([]);
		},
	);

	it.each(["enabled", "disabled"] as const)("retains global write actions when %s", async (configState) => {
		// Given: a writable global source (trusted-project writes have an existing owner test).
		const root = makeRoot("manager-write-control", cleanup);
		setConfig(root, { fx: { ...stdioServer([]), enabled: false } });
		const service = new McpService();
		cleanup.push(() => service.dispose("quit"));
		await attach(service, root, "startup");
		const snapshots = service.getServerSnapshots();
		vi.spyOn(service, "getServerSnapshots").mockReturnValue(
			snapshots.map((snapshot) => ({ ...snapshot, configState })),
		);
		const s = menuInput(["fx", undefined, undefined]);
		const harness = await createHarness({ extensionFactories: [(pi) => registerMcpCommands(pi, service)] });
		cleanup.push(async () => harness.cleanup());
		await harness.session.bindExtensions({ uiContext: s.ui, mode: "tui" });

		// When: the registered /mcp command opens the global server.
		await harness.session.prompt("/mcp");

		// Then: the positive control excludes a manager that hides every write.
		expect(s.menus).toHaveLength(3);
		expect(s.menus[1]?.items.map((item) => item.value)).toEqual(
			expect.arrayContaining([configState === "enabled" ? "disable" : "enable", "exposure"]),
		);
		expect(s.choices).toEqual([]);
		expect(s.ui.notifications).toEqual([]);
	});

	it("preserves exact project bytes through real trustfalse /mcp Details, Logs, and clean exit", async () => {
		// Given: real project config, service, registered slash command and runner trust.
		const root = makeRoot("manager-untrusted-slash", cleanup);
		setConfig(root, {});
		const service = new McpService();
		cleanup.push(() => service.dispose("quit"));
		const s = menuInput(["fx", "status", undefined, "logs", undefined, undefined, undefined]);
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					registerMcpCommands(pi, service);
					pi.on("session_start", async (event, ctx) => {
						await service.attachSession(event, ctx, pi, { agentDir: root.agentDir, env: {} });
					});
				},
			],
		});
		cleanup.push(async () => harness.cleanup());
		harness.settingsManager.setProjectTrusted(false);
		writeProjectConfig(harness.tempDir, {
			fx: {
				...stdioServer([]),
				enabled: true,
				exposure: "search",
				env: { PLACEHOLDER: "$" + "{UNSET:-preserve-me}" },
			},
		});
		const path = join(harness.tempDir, ".senpi", "mcp.json");
		const before = readFileSync(path);
		await harness.session.bindExtensions({ uiContext: s.ui, mode: "tui" });
		expect(await service.whenAttachSettled()).toBe("settled");
		expect(service.getServerSnapshots()).toEqual([
			expect.objectContaining({ name: "fx", source: "project", sourcePath: path, configState: "untrusted" }),
		]);
		expect(service.getConnection("fx")).toBeUndefined();

		// When: /mcp traverses actual server/actions/Details/Logs and cancels both menus.
		await harness.session.prompt("/mcp");

		// Then: the real menu exposes inspection only and disk bytes remain identical.
		const after = readFileSync(path);
		expect(after).toEqual(before);
		expect(s.menus).toHaveLength(7);
		expect(s.menus[0]?.items.map((item) => item.value)).toEqual(["fx"]);
		expect(s.menus[1]?.items.map((item) => item.value)).toEqual(["status", "logs"]);
		expect(s.menus[2]?.items.length).toBeGreaterThan(0);
		expect(s.menus[4]?.items.length).toBeGreaterThan(0);
		expect(s.choices).toEqual([]);
		expect(s.ui.notifications).toEqual([]);
		console.info(
			JSON.stringify({
				channel: "/mcp",
				projectTrusted: false,
				actualMenus: s.menus.map((menu) => ({ title: menu.title, values: menu.items.map((item) => item.value) })),
				beforeBytes: before.length,
				afterBytes: after.length,
				beforeSha256: createHash("sha256").update(before).digest("hex"),
				afterSha256: createHash("sha256").update(after).digest("hex"),
				byteEqual: before.equals(after),
				menuExit: "resolved",
			}),
		);
	});
});
