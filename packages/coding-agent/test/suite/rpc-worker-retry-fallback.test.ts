import { expect, it } from "vitest";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

const FALLBACK_PROBE = `export default function (pi) {
	pi.registerCommand("probe-fallback", {
		description: "report this session's retry fallback settings",
		handler: async (_args, ctx) => {
			pi.rpc.emit("probe.fallback", ctx.sessionSettings.getRetryFallbackSettings());
		},
	});
}`;

type Wire = Awaited<ReturnType<Awaited<ReturnType<typeof startWorkerHost>>["connect"]>>;

async function fallbackOf(wire: Wire, sessionId: string): Promise<unknown> {
	const seen = wire.wait(
		(record) =>
			record.type === "extension_event" && record.name === "probe.fallback" && record.sessionId === sessionId,
	);
	const prompt = await wire.request({ type: "prompt", sessionId, message: "/probe-fallback" });
	expect(prompt.success, String(prompt.error)).toBe(true);
	return (await seen).data;
}

it("gives each worker session only the fallback chain its open_session named", async () => {
	const host = await startWorkerHost(FALLBACK_PROBE, { socket: true });
	try {
		const wire = await host.connect();
		await wire.request({ type: "set_client_info", width: 80, capabilities: ["extension_events"] });
		const first = await wire.request({
			type: "open_session",
			cwd: host.cwd,
			retryFallback: { modelFallback: true, fallbackChains: { "faux/primary": ["faux/spare-a"] } },
		});
		const second = await wire.request({
			type: "open_session",
			cwd: host.cwd,
			retryFallback: { modelFallback: true, fallbackChains: { "faux/primary": ["faux/spare-b"] } },
		});
		const plain = await wire.request({ type: "open_session", cwd: host.cwd });
		expect([first.success, second.success, plain.success]).toEqual([true, true, true]);

		expect(await fallbackOf(wire, String(first.data?.sessionId))).toMatchObject({
			modelFallback: true,
			chains: { "faux/primary": ["faux/spare-a"] },
		});
		expect(await fallbackOf(wire, String(second.data?.sessionId))).toMatchObject({
			modelFallback: true,
			chains: { "faux/primary": ["faux/spare-b"] },
		});
		const plainSettings = await fallbackOf(wire, String(plain.data?.sessionId));
		expect(plainSettings).toMatchObject({
			chains: expect.not.objectContaining({ "faux/primary": expect.anything() }),
		});
	} finally {
		await host.dispose();
	}
}, 90_000);
