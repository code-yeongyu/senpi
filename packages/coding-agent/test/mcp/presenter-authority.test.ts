import { describe, expect, it, vi } from "vitest";
import { McpPresenterAuthority } from "../../src/modes/rpc/mcp-presenter-authority.ts";
import type { McpFormRequest } from "../../src/core/mcp-form-types.ts";

function fixture() {
	let now = 0;
	const timers = new Map<object, () => void>();
	const clock = {
		now: () => now,
		schedule: (callback: () => void) => {
			const timer = {};
			timers.set(timer, callback);
			return timer;
		},
		cancel: (timer: object) => timers.delete(timer),
	};
	const authority = new McpPresenterAuthority({ clock });
	const frames: McpFormRequest[] = [];
	const other: unknown[] = [];
	const a = authority.connect("a", (frame) => {
		if (frame.type === "mcp_form_request") frames.push(frame);
		return true;
	});
	const b = authority.connect("b", (frame) => {
		other.push(frame);
		return true;
	});
	const admission = vi.fn();
	const binding = authority.bind("session", "durable", admission);
	authority.attach(a, binding);
	authority.attach(b, binding);
	// This is the protected launch-owner seam, never an RPC declaration.
	const owner = authority.enroll();
	const registration = owner.register(binding, a, { kind: "desktop" });
	const grant = owner.acquire(registration);
	const operation = new AbortController();
	const presentation = binding.capture();
	if (!presentation) throw new Error("Fixture presenter was not ready");
	const pending = () =>
		presentation.present({
			operationId: "operation",
			inputId: "input",
			round: 0,
			server: { label: "server-canary", source: "user" },
			message: "message-canary",
			schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
			operationSignal: operation.signal,
			presentationSignal: new AbortController().signal,
			deadlineMs: 100,
		});
	const frame = () => {
		const result = frames.at(-1);
		if (!result) throw new Error("No private frame");
		return result;
	};
	const envelope = () => {
		const { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision } = frame();
		return { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision };
	};
	const action = (content: unknown = { value: "answer-canary" }) => ({
		...envelope(),
		type: "mcp_form_response",
		action: "accept",
		content,
	});
	const presented = () => authority.receive(a, { ...envelope(), type: "mcp_form_presented" });
	return {
		authority,
		owner,
		registration,
		grant,
		binding,
		a,
		b,
		frames,
		other,
		admission,
		operation,
		pending,
		frame,
		envelope,
		action,
		presented,
		timers,
		expire: () => {
			now = 100;
			for (const callback of [...timers.values()]) callback();
		},
		elapseWithoutTimer: () => {
			now = 100;
		},
	};
}

describe("host-issued MCP presenter authority", () => {
	it.each(["operation", "presenter", "binding", "timeout"])(
		"settles queued forms on %s without displaying them",
		async (cause) => {
			const f = fixture();
			const first = f.pending();
			const second = f.pending();
			expect(f.frames).toHaveLength(1);
			if (cause === "operation") f.operation.abort();
			else if (cause === "presenter") f.authority.detach(f.a);
			else if (cause === "binding") f.binding.dispose();
			else f.expire();
			const expected = cause === "operation" || cause === "binding" ? "operation_aborted" : "processing_failure";
			expect(await first).toMatchObject({ kind: expected, humanAdmission: false });
			expect(await second).toMatchObject({ kind: expected, humanAdmission: false });
			expect(f.frames).toHaveLength(1);
			expect(f.admission).not.toHaveBeenCalled();
			expect(f.timers.size).toBe(0);
			f.authority.dispose();
		},
	);
	it("rejects a second registration without allocating an unowned grant candidate", () => {
		const f = fixture();
		expect(() => f.owner.register(f.binding, f.a, { kind: "desktop" })).toThrow("presenter_not_authorized");
		expect(f.binding.capture()?.ready()).toBe(true);
		f.owner.revoke(f.registration);
	});
	it("private sync expires the entry even when its timer callback is delayed", async () => {
		const f = fixture();
		const result = f.pending();
		const sync = { ...f.envelope(), type: "mcp_form_sync" };
		f.elapseWithoutTimer();
		expect(f.authority.receive(f.a, sync)).toEqual({ ok: true });
		expect(await result).toMatchObject({ kind: "processing_failure", humanAdmission: false });
		expect(f.admission).not.toHaveBeenCalled();
	});
	it("same-session automated peer cannot read or answer even with a copied token", async () => {
		const f = fixture();
		const result = f.pending();
		expect(f.other).toEqual([]);
		expect(f.authority.receive(f.b, f.action())).toEqual({ error: "presenter_not_authorized" });
		expect(f.authority.receive(f.b, { ...f.action(), dialogId: "invented" })).toEqual({
			error: "presenter_not_authorized",
		});
		expect(f.admission).not.toHaveBeenCalled();
		f.presented();
		expect(f.authority.receive(f.a, f.action())).toEqual({ ok: true });
		expect(await result).toMatchObject({
			kind: "result",
			result: { action: "accept", content: { value: "answer-canary" } },
			source: "presenter_action",
			humanAdmission: true,
		});
		expect(f.admission).toHaveBeenCalledTimes(1);
		expect(f.authority.receive(f.a, f.action())).toEqual({ error: "form_stale" });
		expect(f.admission).toHaveBeenCalledTimes(1);
	});

	it("prepared timeout settles without presenter validation or human admission", async () => {
		const f = fixture();
		const result = f.pending();
		f.expire();
		expect(await result).toMatchObject({
			kind: "processing_failure",
			source: "host_termination",
			humanAdmission: false,
		});
		expect(f.timers.size).toBe(0);
		expect(f.admission).not.toHaveBeenCalled();
		expect(f.authority.receive(f.a, f.action())).toEqual({ error: "form_stale" });
	});

	it("presented revoked holder cancels using its retained entry, never a sibling", async () => {
		const f = fixture();
		const result = f.pending();
		f.presented();
		f.owner.revoke(f.registration);
		expect(await result).toMatchObject({
			kind: "result",
			result: { action: "cancel" },
			source: "host_termination",
			humanAdmission: false,
		});
		expect(f.binding.capture()).toBeUndefined();
		expect(f.admission).not.toHaveBeenCalled();
		expect(f.other).toEqual([]);
		expect(f.authority.receive(f.a, f.action())).toEqual({ error: "presenter_not_authorized" });
	});

	it("binding replacement fences a response queued before dispatch", async () => {
		const f = fixture();
		const result = f.pending();
		f.presented();
		const queued = f.action();
		f.binding.dispose();
		f.authority.bind("session", "replacement", vi.fn());
		expect(f.authority.receive(f.a, queued)).toEqual({ error: "presenter_not_authorized" });
		expect(await result).toMatchObject({ kind: "operation_aborted", humanAdmission: false });
		expect(f.admission).not.toHaveBeenCalled();
		expect(f.frames).toHaveLength(1);
	});

	it("invalid submissions never claim the terminal latch", async () => {
		const f = fixture();
		const result = f.pending();
		expect(f.authority.receive(f.a, f.action())).toEqual({ error: "invalid_form_response" });
		f.presented();
		for (const content of [{}, { value: false }, { value: "ok", extra: "forbidden" }])
			expect(f.authority.receive(f.a, f.action(content))).toEqual({ error: "invalid_form_response" });
		expect(f.authority.receive(f.a, { ...f.action(), humanAdmission: true })).toEqual({
			error: "invalid_form_response",
		});
		expect(f.admission).not.toHaveBeenCalled();
		f.authority.receive(f.a, f.action());
		expect(await result).toMatchObject({ kind: "result", humanAdmission: true });
	});

	it("operation abort wins over subsequent presentation loss", async () => {
		const f = fixture();
		const result = f.pending();
		f.presented();
		f.operation.abort();
		f.owner.revoke(f.registration);
		f.expire();
		expect(await result).toMatchObject({ kind: "operation_aborted", humanAdmission: false });
		expect(f.admission).not.toHaveBeenCalled();
	});

	it("private sync is same-grant only and empty after settlement", async () => {
		const f = fixture();
		const result = f.pending();
		const sync = { ...f.envelope(), type: "mcp_form_sync" };
		expect(f.authority.receive(f.b, sync)).toEqual({ error: "presenter_not_authorized" });
		expect(f.authority.receive(f.a, sync)).toEqual({ ok: true, form: f.frame() });
		f.presented();
		f.authority.receive(f.a, f.action());
		await result;
		expect(f.authority.receive(f.a, sync)).toEqual({ ok: true });
	});
});
