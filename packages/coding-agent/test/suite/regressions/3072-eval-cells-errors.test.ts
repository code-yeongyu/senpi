import { expect, it, vi } from "vitest";
import { createHarness } from "../harness.ts";
import { detach, fixture, rpc, rpcFixture } from "./3072-eval-cells-support.ts";

it.each(["eval_cells.list", "eval_cells.peek", "eval_cells.stop"])(
	"returns a typed unavailable result for %s when codemode is not loaded",
	async (name) => {
		const f = await rpcFixture(await createHarness({ extensionFactories: [] }));
		for (const [type, data] of [
			[name, { cellId: "cell" }],
			["extension_request", { name, data: { cellId: "cell" } }],
		] as const) {
			expect(await rpc(f, type, data)).toMatchObject({ success: false, errorCode: "eval_cells_unavailable" });
		}
	},
);

it("preserves eval error codes through extension_request aliases", async () => {
	const f = await fixture();
	expect(await rpc(f, "extension_request", { name: "eval_cells.peek", data: { cellId: "missing" } })).toMatchObject({
		success: false,
		errorCode: "eval_cell_not_found",
	});
	expect(await rpc(f, "extension_request", { name: "eval_cells.peek", data: { cellId: "" } })).toMatchObject({
		success: false,
		errorCode: "invalid_eval_cell_request",
	});
});

it("advertises eval cell protocol support on the classic connection", async () => {
	const f = await fixture();
	expect(await rpc(f, "get_protocol_info")).toMatchObject({
		success: true,
		data: { capabilities: expect.arrayContaining(["eval_cells"]) },
	});
});

it.each([true, false])("confirms retained state %s on both concurrent stops", async (retained) => {
	vi.useFakeTimers();
	const f = await fixture();
	await detach(f);
	const started = Promise.withResolvers<void>();
	const outcome = Promise.withResolvers<boolean>();
	const interrupt = f.kernel.interrupt.bind(f.kernel);
	f.kernel.interrupt = async (reason) => {
		const handle = await interrupt(reason);
		started.resolve();
		return { ...handle, stateRetained: outcome.promise };
	};
	const first = rpc(f, "eval_cells.stop", { cellId: "cell" });
	await started.promise;
	let secondSettled = false;
	const second = rpc(f, "eval_cells.stop", { cellId: "cell" }).then((value) => {
		secondSettled = true;
		return value;
	});
	try {
		await vi.advanceTimersByTimeAsync(0);
		expect(secondSettled).toBe(false);
	} finally {
		outcome.resolve(retained);
	}
	for (const response of await Promise.all([first, second])) {
		expect(response).toMatchObject({ success: true, data: { state: "cancelled", stateRetained: retained } });
	}
	await vi.runAllTimersAsync();
	expect(f.kernel.interrupts).toHaveLength(1);
	expect(f.notices).toHaveLength(1);
});
