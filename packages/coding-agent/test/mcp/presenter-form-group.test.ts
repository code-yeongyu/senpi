import { describe, expect, it, vi } from "vitest";
import type { McpFormRequest, McpFormResolved, McpFormSettled } from "../../src/core/mcp-form-types.ts";
import { McpPresenterAuthority, type McpPresenterConnection } from "../../src/modes/rpc/mcp-presenter-authority.ts";

type Frame = McpFormRequest | McpFormResolved | McpFormSettled;
interface Holder {
	readonly sender: McpPresenterConnection;
	readonly frames: Frame[];
	revoke(): void;
}

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
	const admission = vi.fn();
	const binding = authority.bind("session", "durable", admission);
	const holder = (
		id: string,
		options: {
			readonly features?: readonly string[];
			readonly identity?: { principalKind: "account"; dev: string; dname: string };
			readonly onFrame?: (frame: Frame) => void;
			readonly refuses?: true;
		} = {},
	): Holder => {
		const frames: Frame[] = [];
		const sender = authority.connect(id, (frame) => {
			frames.push(frame);
			options.onFrame?.(frame);
			return options.refuses === undefined;
		});
		authority.attach(sender, binding);
		const owner = authority.enroll(`principal-${id}`, options.identity);
		const registration = owner.register(binding, sender, { kind: "desktop", features: options.features });
		owner.acquire(registration);
		return { sender, frames, revoke: () => owner.revoke(registration) };
	};
	const operation = new AbortController();
	const present = (label = "form") => {
		const presentation = binding.capture();
		if (!presentation) throw new Error("No holder is ready");
		return presentation.present({
			operationId: "operation",
			inputId: label,
			round: 0,
			server: { label: "server-canary", source: "user" },
			message: `message-canary ${label}`,
			schema: {
				type: "object",
				properties: { value: { type: "string", description: "schema-canary" } },
				required: ["value"],
			},
			operationSignal: operation.signal,
			presentationSignal: new AbortController().signal,
			deadlineMs: 100,
		});
	};
	const requests = (h: Holder) =>
		h.frames.filter((frame): frame is McpFormRequest => frame.type === "mcp_form_request");
	const resolutions = (h: Holder) => h.frames.filter((frame) => frame.type === "mcp_form_resolved");
	const settlements = (h: Holder) => h.frames.filter((frame) => frame.type === "mcp_form_settled");
	const envelope = (h: Holder) => {
		const request = requests(h).at(-1);
		if (!request) throw new Error("No private request");
		const { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision } = request;
		return { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision };
	};
	const presented = (h: Holder) => authority.receive(h.sender, { ...envelope(h), type: "mcp_form_presented" });
	const accept = (h: Holder, value = "answer-canary") =>
		authority.receive(h.sender, { ...envelope(h), type: "mcp_form_response", action: "accept", content: { value } });
	const expire = () => {
		now = 100;
		for (const callback of [...timers.values()]) callback();
	};
	return {
		authority,
		binding,
		admission,
		operation,
		holder,
		present,
		requests,
		resolutions,
		settlements,
		envelope,
		presented,
		accept,
		expire,
		timers,
	};
}

const pending = Symbol("pending");
const settledYet = (result: Promise<unknown>) => Promise.race([result, Promise.resolve(pending)]);

describe("multi-holder MCP form group (D11 S3-3b)", () => {
	it("T5: first answer wins and the audit names the device", async () => {
		const f = fixture();
		const a = f.holder("a", { features: ["elsewhere_v1"] });
		const b = f.holder("remote-origin-canary", {
			features: ["elsewhere_v1"],
			identity: { principalKind: "account", dev: "dev-b", dname: "Device B" },
		});
		const result = f.present();
		expect(f.requests(a)).toHaveLength(1);
		expect(f.requests(b)).toHaveLength(1);
		expect(f.envelope(a).dialogId).not.toBe(f.envelope(b).dialogId);
		expect(f.envelope(a).dialogToken).not.toBe(f.envelope(b).dialogToken);
		const late = { ...f.envelope(a), type: "mcp_form_response", action: "accept", content: { value: "late" } };
		expect(f.presented(a)).toEqual({ ok: true });
		expect(f.presented(b)).toEqual({ ok: true });
		expect(f.accept(b)).toEqual({ ok: true });
		expect(await result).toEqual({
			kind: "result",
			result: { action: "accept", content: { value: "answer-canary" } },
			source: "presenter_action",
			humanAdmission: true,
		});
		expect(f.resolutions(a)).toEqual([
			{
				type: "mcp_form_resolved",
				sessionId: "session",
				grantId: f.envelope(a).grantId,
				dialogId: f.envelope(a).dialogId,
				reason: "answered",
				elsewhere: true,
			},
		]);
		expect(f.resolutions(b)).toEqual([
			{
				type: "mcp_form_resolved",
				sessionId: "session",
				grantId: f.envelope(b).grantId,
				dialogId: f.envelope(b).dialogId,
				reason: "answered",
			},
		]);
		expect(f.authority.receive(a.sender, late)).toEqual({ error: "form_stale" });
		f.operation.abort();
		f.expire();
		a.revoke();
		b.revoke();
		expect(f.admission).toHaveBeenCalledTimes(1);
		const record = {
			type: "mcp_form_settled",
			sessionId: "session",
			groupId: expect.any(String),
			outcome: "answered",
			answeredBy: { principalKind: "account", dev: "dev-b", dname: "Device B", presenterKind: "desktop" },
		};
		expect(f.settlements(a)).toEqual([record]);
		expect(f.settlements(b)).toEqual(f.settlements(a));
		expect(JSON.stringify(f.settlements(a))).not.toContain("remote-origin-canary");
	});

	it("T10: a second form waits behind the first group regardless of which holder answers", async () => {
		const f = fixture();
		const a = f.holder("a");
		const b = f.holder("b");
		const first = f.present("first");
		const second = f.present("second");
		expect(f.requests(a).map((request) => request.message)).toEqual(["message-canary first"]);
		expect(f.requests(b).map((request) => request.message)).toEqual(["message-canary first"]);
		f.presented(a);
		f.accept(a, "first-answer");
		expect(await first).toMatchObject({ kind: "result", result: { content: { value: "first-answer" } } });
		await vi.waitFor(() => expect(f.requests(b)).toHaveLength(2));
		expect(f.requests(a).map((request) => request.message)).toEqual([
			"message-canary first",
			"message-canary second",
		]);
		expect(f.requests(b).at(-1)?.message).toBe("message-canary second");
		f.presented(b);
		f.accept(b, "second-answer");
		expect(await second).toMatchObject({ kind: "result", result: { content: { value: "second-answer" } } });
		expect(f.resolutions(a).map((frame) => frame.type === "mcp_form_resolved" && frame.reason)).toEqual([
			"answered",
			"answered",
		]);
	});

	it("a holder that acquires after a form reached the head gets no dialog for it, only the next form", async () => {
		const f = fixture();
		const a = f.holder("a");
		const first = f.present("first");
		const second = f.present("second");
		const version = f.binding.version?.();
		const late = f.holder("late");
		expect(f.requests(late)).toEqual([]);
		expect(f.binding.version?.()).toBe(version);
		expect(f.authority.receive(late.sender, { ...f.envelope(a), type: "mcp_form_presented" })).toEqual({
			error: "presenter_not_authorized",
		});
		f.presented(a);
		f.accept(a, "first-answer");
		expect(await first).toMatchObject({ kind: "result", result: { content: { value: "first-answer" } } });
		expect(f.resolutions(late)).toEqual([]);
		await vi.waitFor(() => expect(f.requests(late)).toHaveLength(1));
		expect(f.requests(late)[0]?.message).toBe("message-canary second");
		f.presented(late);
		f.accept(late, "second-answer");
		expect(await second).toMatchObject({ kind: "result", result: { content: { value: "second-answer" } } });
	});

	it("T12: mcp_form_settled is value-free", async () => {
		const f = fixture();
		const writes: string[] = [];
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			writes.push(String(chunk));
			return true;
		});
		const log = vi.spyOn(console, "log").mockImplementation((...args) => void writes.push(args.join(" ")));
		const error = vi.spyOn(console, "error").mockImplementation((...args) => void writes.push(args.join(" ")));
		try {
			const a = f.holder("a", { features: ["elsewhere_v1"] });
			const b = f.holder("b", { identity: { principalKind: "account", dev: "dev-b", dname: "Device B" } });
			const observer = f.authority.connect("observer", () => {
				writes.push("observer-frame");
				return true;
			});
			f.authority.attach(observer, f.binding);
			const result = f.present();
			const answerIds = [a, b].flatMap((h) => Object.values(f.envelope(h)).filter((value) => value !== "session"));
			f.presented(b);
			f.accept(b, "draft-canary content-canary");
			await result;
			const settled = f.settlements(a);
			expect(settled).toHaveLength(1);
			const record = JSON.stringify(settled);
			for (const secret of [
				"message-canary",
				"schema-canary",
				"server-canary",
				"draft-canary",
				"content-canary",
				...answerIds,
			])
				expect(record).not.toContain(secret);
			expect(Object.keys(settled[0] ?? {}).sort()).toEqual([
				"answeredBy",
				"groupId",
				"outcome",
				"sessionId",
				"type",
			]);
			expect(f.settlements(b)).toEqual([]);
			expect(writes.join("\n")).not.toMatch(/canary|observer-frame/);
		} finally {
			stderr.mockRestore();
			log.mockRestore();
			error.mockRestore();
		}
	});

	it("one holder loss does not end the form", async () => {
		const f = fixture();
		const a = f.holder("a");
		const b = f.holder("b");
		const version = f.binding.version?.();
		const result = f.present();
		const lost = { ...f.envelope(a), type: "mcp_form_presented" };
		f.presented(a);
		a.revoke();
		expect(await settledYet(result)).toBe(pending);
		expect(f.authority.receive(a.sender, lost)).toEqual({ error: "presenter_not_authorized" });
		expect(f.binding.capture()?.ready()).toBe(true);
		expect(f.binding.version?.()).toBe(version);
		expect(f.presented(b)).toEqual({ ok: true });
		expect(f.accept(b)).toEqual({ ok: true });
		expect(await result).toMatchObject({ kind: "result", source: "presenter_action", humanAdmission: true });
	});

	it.each([
		["presented", "cancel"],
		["prepared", "processing_failure"],
	] as const)("last-holder loss terminates a %s form without human admission", async (stage, expected) => {
		const f = fixture();
		const a = f.holder("a");
		const b = f.holder("b");
		const result = f.present("first");
		const queued = f.present("second");
		if (stage === "presented") f.presented(b);
		a.revoke();
		expect(await settledYet(result)).toBe(pending);
		b.revoke();
		const outcome = await result;
		if (expected === "cancel")
			expect(outcome).toEqual({
				kind: "result",
				result: { action: "cancel" },
				source: "host_termination",
				humanAdmission: false,
			});
		else expect(outcome).toEqual({ kind: "processing_failure", source: "host_termination", humanAdmission: false });
		expect(await queued).toMatchObject({ kind: "processing_failure", humanAdmission: false });
		expect(f.binding.capture()).toBeUndefined();
		expect(f.admission).not.toHaveBeenCalled();
		expect([...f.resolutions(a), ...f.resolutions(b), ...f.settlements(a), ...f.settlements(b)]).toEqual([]);
		expect(f.timers.size).toBe(0);
	});

	it("a holder whose delivery fails leaves; the form ends only when no holder took it", async () => {
		const f = fixture();
		const broken = f.holder("broken", { refuses: true });
		const working = f.holder("working");
		const survived = f.present("survived");
		expect(await settledYet(survived)).toBe(pending);
		f.presented(working);
		f.accept(working);
		expect(await survived).toMatchObject({ kind: "result", source: "presenter_action" });
		working.revoke();
		const other = f.holder("other", { refuses: true });
		const lost = f.present("lost");
		expect(await lost).toEqual({ kind: "processing_failure", source: "host_termination", humanAdmission: false });
		expect(f.timers.size).toBe(0);
		expect([...f.resolutions(broken), ...f.resolutions(other)]).toEqual([]);
		expect(f.binding.capture()?.ready()).toBe(true);
	});

	it("a grant without elsewhere_v1 never receives the key", async () => {
		const f = fixture();
		const plain = f.holder("plain");
		const unknown = f.holder("unknown", { features: ["future_v9"] });
		const negotiated = f.holder("negotiated", { features: ["elsewhere_v1"] });
		const winner = f.holder("winner", { features: ["elsewhere_v1"] });
		const answered = f.present("answered");
		f.presented(winner);
		f.accept(winner);
		await answered;
		const timedOut = f.present("timeout");
		await vi.waitFor(() => expect(f.requests(plain)).toHaveLength(2));
		f.expire();
		await timedOut;
		for (const h of [plain, unknown]) {
			expect(f.resolutions(h)).toHaveLength(2);
			for (const frame of f.resolutions(h)) expect(Object.keys(frame)).not.toContain("elsewhere");
		}
		expect(f.resolutions(negotiated).map((frame) => "elsewhere" in frame && frame.elsewhere)).toEqual([true, false]);
		expect(f.resolutions(winner).map((frame) => "elsewhere" in frame)).toEqual([false, false]);
		expect([...f.settlements(plain), ...f.settlements(unknown)]).toEqual([]);
		expect(f.settlements(negotiated).map((record) => record.outcome)).toEqual(["answered", "processing_failed"]);
		expect(f.settlements(negotiated).map((record) => "answeredBy" in record)).toEqual([true, false]);
	});

	it("a holder that answers synchronously while the group starts closes it before later holders see it", async () => {
		const f = fixture();
		let answering = true;
		const eager = f.holder("eager", {
			onFrame: (frame) => {
				if (frame.type !== "mcp_form_request" || !answering) return;
				answering = false;
				f.presented(eager);
				f.accept(eager);
			},
		});
		const later = f.holder("later");
		const result = f.present();
		expect(await result).toMatchObject({ kind: "result", source: "presenter_action" });
		expect(later.frames).toEqual([]);
		expect(f.admission).toHaveBeenCalledTimes(1);
		expect(f.resolutions(eager)).toHaveLength(1);
	});
});
