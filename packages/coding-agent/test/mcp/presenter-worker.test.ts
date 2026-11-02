import { expect, it, vi } from "vitest";
import { privateMcpForms } from "../../src/core/mcp-form-types.ts";
import { McpFormWorker } from "../../src/modes/rpc/mcp-form-worker.ts";
import type { SessionWorkerToHost } from "../../src/modes/rpc/session-worker-protocol.ts";

// senpi#4210: a missing host bind acknowledgement must not wedge session rebind.
it("bounds a missing worker binding acknowledgement and releases a late binding", async () => {
	vi.useFakeTimers();
	try {
		const sent: SessionWorkerToHost[] = [];
		const worker = new McpFormWorker((message) => sent.push(message));
		const ui = {};
		let failure: unknown;
		void worker.bind("durable", ui, vi.fn()).catch((error: unknown) => {
			failure = error;
		});
		const bind = sent[0];
		if (bind?.type !== "mcp_form_bind") throw new Error("Missing bind");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(failure).toMatchObject({ message: "private_form_unavailable" });
		expect(privateMcpForms(ui)).toBeUndefined();
		worker.receive({ type: "mcp_form_bound", id: bind.id, epoch: "late", version: "grant" });
		expect(sent.at(-1)).toEqual({ type: "mcp_form_release", epoch: "late" });
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
	}
});

it.each(["presenter_action", "host_termination"] as const)(
	"worker admits only winning %s provenance once",
	async (source) => {
		const sent: SessionWorkerToHost[] = [];
		const worker = new McpFormWorker((message) => sent.push(message));
		const ui = {};
		const admit = vi.fn();
		const bound = worker.bind("durable", ui, admit);
		const request = sent[0];
		if (request?.type !== "mcp_form_bind") throw new Error("Missing bind");
		worker.receive({ type: "mcp_form_bound", id: request.id, epoch: "epoch", version: "grant" });
		const dispose = await bound;
		const presentation = privateMcpForms(ui)?.capture();
		if (!presentation) throw new Error("Missing presentation");
		const operation = new AbortController();
		const result = presentation.present({
			operationId: "operation",
			inputId: "input",
			round: 0,
			message: "private",
			server: { label: "configured", source: "user" },
			schema: { type: "object", properties: {} },
			operationSignal: operation.signal,
			presentationSignal: new AbortController().signal,
			deadlineMs: 1000,
		});
		const create = sent.find((message) => message.type === "mcp_form_create");
		if (create?.type !== "mcp_form_create") throw new Error("Missing create");
		const outcome =
			source === "presenter_action"
				? ({ kind: "result", result: { action: "cancel" }, source, humanAdmission: true } as const)
				: ({ kind: "result", result: { action: "cancel" }, source, humanAdmission: false } as const);
		const settlement = {
			type: "mcp_form_settlement",
			id: create.id,
			epoch: "epoch",
			settlementId: "one",
			outcome,
		} as const;
		worker.receive(settlement);
		worker.receive(settlement);
		expect(await result).toEqual(outcome);
		expect(admit).toHaveBeenCalledTimes(source === "presenter_action" ? 1 : 0);
		expect(sent.every((message) => message.type.startsWith("mcp_form_"))).toBe(true);
		dispose();
	},
);

it("publishes worker presenter availability changes to legacy connection observers", async () => {
	const sent: SessionWorkerToHost[] = [];
	const worker = new McpFormWorker((message) => sent.push(message));
	const ui = {};
	const binding = worker.bind("durable", ui, vi.fn());
	const request = sent[0];
	if (request?.type !== "mcp_form_bind") throw new Error("Missing bind");
	worker.receive({ type: "mcp_form_bound", id: request.id, epoch: "epoch" });
	const dispose = await binding;
	const forms = privateMcpForms(ui);
	const changed = vi.fn(() => forms?.capture()?.ready() === true);
	const off = forms?.subscribe?.(changed);
	try {
		worker.receive({ type: "mcp_form_availability", epoch: "epoch", version: "grant" });
		worker.receive({ type: "mcp_form_availability", epoch: "epoch", version: "grant" });
		worker.receive({ type: "mcp_form_availability", epoch: "epoch" });
		expect(changed.mock.results.map((result) => result.value)).toEqual([true, false]);
		off?.();
		worker.receive({ type: "mcp_form_availability", epoch: "epoch", version: "next" });
		expect(changed).toHaveBeenCalledTimes(2);
	} finally {
		dispose();
	}
});

it("worker abort publishes its atomic fence before the host can dispatch a queued response", async () => {
	const sent: SessionWorkerToHost[] = [];
	const worker = new McpFormWorker((message) => sent.push(message));
	const ui = {};
	const bound = worker.bind("durable", ui, vi.fn());
	const bind = sent[0];
	if (bind?.type !== "mcp_form_bind") throw new Error("Missing bind");
	worker.receive({ type: "mcp_form_bound", id: bind.id, epoch: "epoch", version: "grant" });
	const dispose = await bound;
	const presentation = privateMcpForms(ui)?.capture();
	if (!presentation) throw new Error("Missing presentation");
	const operation = new AbortController();
	const result = presentation.present({
		operationId: "operation",
		inputId: "input",
		round: 0,
		message: "private",
		server: { label: "configured", source: "user" },
		schema: { type: "object", properties: {} },
		operationSignal: operation.signal,
		presentationSignal: new AbortController().signal,
		deadlineMs: 1000,
	});
	const create = sent.find((message) => message.type === "mcp_form_create");
	if (create?.type !== "mcp_form_create") throw new Error("Missing create");
	const fence = new Int32Array(create.operationFence);
	expect(Atomics.load(fence, 0)).toBe(0);
	operation.abort();
	expect(Atomics.load(fence, 0)).toBe(1);
	dispose();
	worker.receive({
		type: "mcp_form_settlement",
		id: create.id,
		epoch: "epoch",
		settlementId: "one",
		outcome: { kind: "operation_aborted", source: "host_termination", humanAdmission: false },
	});
	expect(await result).toMatchObject({ kind: "operation_aborted", humanAdmission: false });
});
