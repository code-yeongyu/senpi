import { mkdirSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startFakeModelServer } from "../helpers/rpc-fake-model.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import {
	connectPeer,
	openedSessionId,
	scratch,
	spawnRpc,
	stopChild,
	waitForStderr,
} from "../helpers/rpc-socket-host-support.ts";

describe("RPC Unix-socket multi-connection host", () => {
	it("keeps factory UI off the wire while preserving array widgets", async () => {
		const qa = scratch("widget-default");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		mkdirSync(join(qa.agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(qa.agentDir, "extensions", "widget-factory.ts"),
			`export default function (pi) {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.setWidget("array-widget", ["array widget"]);
				ctx.ui.setWidget("action-widget", ["choose"], { actions: [{ label: "Go", command: "/go" }] });
				ctx.ui.setWidget("action-widget", undefined, { actions: [{ label: "Go", command: "/go" }] });
				ctx.ui.setWidget("empty-actions-widget", ["plain"], { actions: [] });
				ctx.ui.setWidget("factory-widget", () => ({ render: () => ["factory"] }));
				ctx.ui.setHeader(() => ({ render: () => ["header"] }));
				ctx.ui.setFooter((_tui, _theme, footerData) => ({ render: () => [footerData.getGitBranch() ?? "footer"] }));
			});
		}`,
		);
		const child = spawnRpc(
			[
				"--mode",
				"rpc",
				"--listen",
				`unix://${qa.socketPath}`,
				"--provider",
				MOCK_PROVIDER,
				"--model",
				MOCK_MODEL,
				"--extension",
				join(qa.agentDir, "extensions", "widget-factory.ts"),
			],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const peer = await connectPeer(qa.socketPath);
		try {
			const opened = await peer.peer.request({ id: "open", type: "open_session", cwd: qa.cwd });
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			expect(opened).toMatchObject({ success: true });
			expect(
				peer.peer.messages.filter(
					(value) =>
						value.type === "extension_ui_request" &&
						["factory-widget", "setHeader", "setFooter"].includes(String(value.widgetKey ?? value.method)),
				),
			).toEqual([]);
			expect(peer.peer.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						method: "setWidget",
						widgetKey: "array-widget",
						widgetLines: ["array widget"],
					}),
				]),
			);
			const actionRecords = peer.peer.messages.filter(
				(value) =>
					value.type === "extension_ui_request" &&
					["action-widget", "empty-actions-widget"].includes(String(value.widgetKey)),
			);
			expect(actionRecords.map((value) => [value.widgetKey, value.widgetLines, value.widgetActions])).toEqual([
				["action-widget", ["choose"], [{ label: "Go", command: "/go" }]],
				["action-widget", undefined, undefined],
				["empty-actions-widget", ["plain"], undefined],
			]);
			expect(actionRecords.every((value) => !("widgetActions" in value) || value.widgetLines !== undefined)).toBe(
				true,
			);
		} finally {
			peer.peer.close();
			peer.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("dispatches a reentrant UI response while switch_session is in flight", async () => {
		const qa = scratch("reent");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		mkdirSync(join(qa.agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(qa.agentDir, "extensions", "reentrant-ui.ts"),
			`export default function (pi) {
				pi.on("session_before_switch", async (_event, ctx) => {
					await ctx.ui.confirm("Reentrant switch", "Allow session switch?");
				});
			}\n`,
		);
		const child = spawnRpc(
			[
				"--mode",
				"rpc",
				"--listen",
				`unix://${qa.socketPath}`,
				"--provider",
				MOCK_PROVIDER,
				"--model",
				MOCK_MODEL,
				"--extension",
				join(qa.agentDir, "extensions", "reentrant-ui.ts"),
			],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const peer = await connectPeer(qa.socketPath);
		try {
			const opened = await peer.peer.request({
				id: "open",
				type: "open_session",
				cwd: qa.cwd,
			});
			const ui = peer.peer.waitFor(
				(value) => value.type === "extension_ui_request" && value.method === "confirm",
				5_000,
			);
			const switched = peer.peer.request(
				{
					id: "switch",
					type: "switch_session",
					sessionId: openedSessionId(opened),
					sessionPath: join(qa.sessionDir, "switch.jsonl"),
				},
				5_000,
			);
			const request = await ui;
			expect(request).toMatchObject({
				type: "extension_ui_request",
				method: "confirm",
			});
			peer.peer.write({
				type: "extension_ui_response",
				id: request.id,
				sessionId: openedSessionId(opened),
				confirmed: true,
			});
			await expect(switched).resolves.toMatchObject({
				success: true,
				command: "switch_session",
			});
			expect(opened).toMatchObject({ success: true });
		} finally {
			peer.peer.close();
			peer.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});
});
