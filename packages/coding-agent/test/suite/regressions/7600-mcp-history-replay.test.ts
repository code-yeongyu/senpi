import { expect, it } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../../src/core/extensions/builtin/mcp/service.ts";
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

// #7600: acquiring getEntries() alone rereads and pins the transcript after idle, even if replay has no work.
it("leaves released history on disk when MCP attaches with no searchable tools", async () => {
	const cleanups: Array<() => Promise<void>> = [];
	const root = makeRoot("7600-replay", cleanups);
	setConfig(root, {});
	const manager = SessionManager.open(writeCompactedTranscript(root.cwd, 1), root.cwd);
	resetMcpServiceForTests();
	const service = getMcpService();
	try {
		manager.dropMaterializedCaches();
		await service.attachSession(
			{ type: "session_start", reason: "reload" },
			{ cwd: root.cwd, isProjectTrusted: () => true, sessionManager: manager },
			fakePi(),
			{ agentDir: root.agentDir },
		);
		expect(manager.holdsMaterializedHistory()).toBe(false);
	} finally {
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
