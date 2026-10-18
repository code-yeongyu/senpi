/**
 * The fixture emits its factory UI BEFORE its array widget, and one session's
 * records reach a connection in order, so once the array widget has arrived any
 * factory frame the host produced would already be in `records`.
 */
import { expect, it, vi } from "vitest";
import { startInProcessHost } from "../rpc-worker-host-support.ts";

const LEGACY_CAPABILITY = "rendered_components";

const FACTORY_THEN_ARRAY_UI = `export default function (pi) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWidget("factory-widget", () => ({ render: (width) => ["factory:" + width] }));
		ctx.ui.setHeader(() => ({ render: () => ["factory header"] }));
		ctx.ui.setFooter(() => ({ render: () => ["factory footer"] }));
		ctx.ui.setWidget("array-widget", ["array widget"]);
	});
}`;

it("accepts a client advertising the removed rendered_components capability and sends it ordinary records only", async () => {
	// Given: a source-built in-process socket host whose extension sets factory UI and one array widget.
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startInProcessHost(FACTORY_THEN_ARRAY_UI);
	try {
		const client = await host.connect();

		// When: the client registers the legacy capability before and after opening its session.
		const connectionInfo = await client.request({
			type: "set_client_info",
			width: 80,
			capabilities: [LEGACY_CAPABILITY],
		});
		const arrayWidget = client.wait(
			(record) => record.type === "extension_ui_request" && record.widgetKey === "array-widget",
		);
		const open = await client.request({ type: "open_session", cwd: host.cwd });
		const sessionId = open.data?.sessionId;
		await arrayWidget;
		const sessionInfo = await client.request({
			type: "set_client_info",
			sessionId,
			width: 120,
			capabilities: [LEGACY_CAPABILITY],
		});

		// Then: every request succeeds, nothing on the wire is an error, and no factory frame was delivered.
		expect([connectionInfo, open, sessionInfo].map((response) => response.success)).toEqual([true, true, true]);
		expect(client.records.filter((record) => record.success === false)).toEqual([]);
		expect(
			client.records.filter(
				(record) =>
					record.type === "extension_ui_request" &&
					(record.widgetKey === "factory-widget" ||
						record.method === "setHeader" ||
						record.method === "setFooter"),
			),
		).toEqual([]);
		expect(client.records).toContainEqual(
			expect.objectContaining({
				type: "extension_ui_request",
				method: "setWidget",
				widgetKey: "array-widget",
				widgetLines: ["array widget"],
				sessionId,
			}),
		);
	} finally {
		await host.dispose();
	}
}, 120_000);
