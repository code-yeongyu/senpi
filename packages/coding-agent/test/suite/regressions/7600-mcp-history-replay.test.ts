import { expect, it } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { activationMarkers } from "../../../src/core/extensions/builtin/tool-search/activation-history.ts";
import {
	emitActivationMarker,
	deriveMcpRegistrationId,
	LEGACY_TOOL_SEARCH_ACTIVATION_MARKER,
} from "../../../src/core/extensions/builtin/tool-search/engine/marker.ts";
import {
	loadEntriesFromFile,
	SessionManager,
	setSessionEntryLoaderForTesting,
} from "../../../src/core/session-manager.ts";
import { writeCompactedTranscript } from "../../benchmarks/3519-compacted-transcript.ts";
import { cleanupRoots, fakePi, makeRoot, setConfig, stdioServer } from "../../mcp/fixtures/service-lifecycle.ts";

// #7600: acquiring getEntries() alone rereads and pins the transcript after idle, even if replay has no work. Any
// whole-history read, a held view or a fold's one-off read, goes through the entry loader.
it("reads nothing of a released history when MCP attaches with no searchable tools", async () => {
	const cleanups: Array<() => Promise<void>> = [];
	const root = makeRoot("7600-replay", cleanups);
	setConfig(root, {});
	const manager = SessionManager.open(writeCompactedTranscript(root.cwd, 1), root.cwd);
	resetMcpServiceForTests();
	const service = getMcpService();
	let reads = 0;
	const restore = setSessionEntryLoaderForTesting((...args) => {
		reads++;
		return loadEntriesFromFile(...args);
	});
	try {
		manager.dropMaterializedCaches();
		await service.attachSession(
			{ type: "session_start", reason: "reload" },
			{ cwd: root.cwd, isProjectTrusted: () => true, sessionManager: manager },
			fakePi(),
			{ agentDir: root.agentDir },
		);
		expect(reads).toBe(0);
		expect(manager.holdsMaterializedHistory()).toBe(false);
	} finally {
		restore();
		await service.dispose("quit");
		resetMcpServiceForTests();
		manager.dispose();
		await cleanupRoots(cleanups);
	}
});

// A new extension generation must replay historical promotions and markers appended since the last scan.
it("restores both generations of promotions after idle without reparsing the session", async () => {
	const cleanups: Array<() => Promise<void>> = [];
	const root = makeRoot("7600-reloaded-tools", cleanups);
	setConfig(root, { fx: { ...stdioServer(["--tools", "3"]), exposure: "search" } });
	const manager = SessionManager.create(root.cwd, root.cwd);
	manager.appendMessage({
		role: "user",
		content: LEGACY_TOOL_SEARCH_ACTIVATION_MARKER + " mcp_fx_tool_1",
		timestamp: 1,
	});
	const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
	manager.appendCompaction("summary", kept, 1000);
	resetMcpServiceForTests();
	const attach = async () => {
		const pi = fakePi();
		const service = getMcpService();
		await service.attachSession(
			{ type: "session_start", reason: "reload" },
			{
				cwd: root.cwd,
				isProjectTrusted: () => true,
				sessionManager: manager,
			},
			pi,
			{ agentDir: root.agentDir },
		);
		await service.whenAttachSettled();
		return pi.getActiveTools();
	};
	let reads = 0;
	const restore = setSessionEntryLoaderForTesting((...args) => {
		reads++;
		return loadEntriesFromFile(...args);
	});
	try {
		expect(await attach()).toContain("mcp_fx_tool_1");
		await getMcpService().dispose("reload");
		resetMcpServiceForTests();
		manager.appendMessage({
			role: "user",
			timestamp: 3,
			content: emitActivationMarker([
				{ name: "mcp_fx_tool_2", registrationId: deriveMcpRegistrationId("fx", "tool_2") },
			]),
		});
		manager.dropMaterializedCaches();
		reads = 0;
		expect(await attach()).toEqual(expect.arrayContaining(["mcp_fx_tool_1", "mcp_fx_tool_2"]));
		expect(reads).toBe(0);
	} finally {
		restore();
		await getMcpService().dispose("quit");
		resetMcpServiceForTests();
		manager.dispose();
		await cleanupRoots(cleanups);
	}
});

// The session keeps this fold's state for its life, so it holds the parsed promotions only, never an entry: a tool
// result that merely quotes the marker text (a read of the tool-search sources) would otherwise stay resident whole.
it("keeps parsed promotions, not the entries they came from, in the session's fold", () => {
	const manager = SessionManager.inMemory();
	const quoted = `export const LEGACY_TOOL_SEARCH_ACTIVATION_MARKER = "${LEGACY_TOOL_SEARCH_ACTIVATION_MARKER}";\n`;
	manager.appendMessage({ role: "user", content: quoted + "source line\n".repeat(20_000), timestamp: 1 });
	manager.appendMessage({
		role: "user",
		content: `${LEGACY_TOOL_SEARCH_ACTIVATION_MARKER} mcp_fx_tool_1`,
		timestamp: 2,
	});
	expect(manager.reduceHistory(activationMarkers)).toEqual([{ version: 1, names: ["mcp_fx_tool_1"] }]);
});
