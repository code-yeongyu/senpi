// Brain/hand split plan row S16c (Z2.ISO.c): one MCP extension instance serving several execution scopes keeps
// each scope's attach, control inventory, forms, presentation, skill reveal and calls; a scope attached later does
// not take over an earlier one's.
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { sharingHttpFixture } from "../mcp/fixtures/sharing-http.ts";
import { inputResult, MrtrScript, startMrtrServer } from "../mcp/fixtures/mrtr-2026-server.ts";
import { mrtrTui } from "../mcp/fixtures/mrtr-presentation.ts";
import { createTestUiContext } from "../suite/harness.ts";
import {
	type McpScopedRuntime,
	type McpScopedRuntimeOptions,
	mcpRuntimeWithScopes,
	startTurn,
	writeSkill,
} from "./scope-mcp-harness.ts";

const runtimes: McpScopedRuntime[] = [];
const closers: Array<() => Promise<void>> = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
	for (const close of closers.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});

async function runtime(options: McpScopedRuntimeOptions) {
	const created = await mcpRuntimeWithScopes(options);
	runtimes.push(created);
	const [a, b] = created.scopes;
	if (a === undefined) throw new Error("at least one scope expected");
	return { ...created, a, b: b ?? a };
}

function answering(answer: string) {
	const input = vi.fn(async () => answer);
	return { input, ui: createTestUiContext({ input }) };
}

async function legacyServer(tool: string): Promise<Record<string, unknown>> {
	const fixture = await sharingHttpFixture();
	fixture.setTools(tool);
	closers.push(fixture.close);
	return { fx: { type: "http", url: fixture.url, auth: false, exposure: "direct" } };
}

const plainUis = () => [createTestUiContext(), createTestUiContext()];

describe("MCP state is scoped per execution scope (S16c)", () => {
	it("MULTI: every scope a runtime attached keeps answering its own control inventory", async () => {
		// Given a runtime whose scopes A and B each attached at their first tool call, A first.
		const { a, b, attach, answered } = await runtime({ uis: plainUis(), mode: "print" });
		await attach(a);
		await attach(b);

		// When each scope asks for its inventory.
		// Then both are answered: B attaching later did not take A's place.
		expect(answered(a.sessionId)).toBe(true);
		expect(answered(b.sessionId)).toBe(true);
		expect(answered("not-attached")).toBe(false);
	});

	it("keeps one session's inventory after a session_start, as before scopes existed", async () => {
		// Given scope A attached at its first tool call, then scope B's session started.
		const { a, b, attach, answered, service } = await runtime({ uis: plainUis(), mode: "print" });
		await attach(a);
		await b.runner.emit({ type: "session_start", reason: "startup" });
		await service.whenAttachSettled(10_000);

		// Then only the started session answers.
		expect(answered(b.sessionId)).toBe(true);
		expect(answered(a.sessionId)).toBe(false);
	});

	it("MULTI: a form from one scope's MCP call opens in that scope's UI, never another's", async () => {
		// Given scopes A and B of one runtime, each attached and each with its own UI.
		const formA = answering("from-A");
		const formB = answering("from-B");
		const { a, b, attach, call } = await runtime({
			uis: [formA.ui, formB.ui],
			servers: await legacyServer("elicit"),
		});
		await attach(a);
		await attach(b);

		// When A's call asks for input, then B's call does.
		const fromA = await call(a, "mcp_fx_elicit");
		const fromB = await call(b, "mcp_fx_elicit");

		// Then each form opened once, in its own scope's UI, and each answer reached its own call.
		expect(formA.input).toHaveBeenCalledOnce();
		expect(formB.input).toHaveBeenCalledOnce();
		expect(fromA).toContain("from-A");
		expect(fromB).toContain("from-B");
	});

	it("MULTI: a form arriving while two scopes' calls share one connection opens in neither UI", async () => {
		// Given scopes A and B of one runtime, each with a call in flight on the one connection to server fx.
		const formA = answering("from-A");
		const formB = answering("from-B");
		const fixture = await sharingHttpFixture();
		closers.push(fixture.close);
		const servers = { fx: { type: "http", url: fixture.url, auth: false, exposure: "direct" } };
		const { a, b, attach, call } = await runtime({ uis: [formA.ui, formB.ui], servers });
		await attach(a);
		await attach(b);
		const held = fixture.holdCalls(2);
		const calls = [call(a, "mcp_fx_echo", { value: "A" }), call(b, "mcp_fx_echo", { value: "B" })];
		try {
			await held;

			// When the server asks for input it cannot attribute to one of the two calls.
			const asked = fixture.elicit();

			// Then it is refused without showing a form in either scope's UI.
			await expect(asked).rejects.toMatchObject({ code: ErrorCode.InternalError });
			expect(formA.input).not.toHaveBeenCalled();
			expect(formB.input).not.toHaveBeenCalled();
		} finally {
			fixture.releaseCalls();
			await Promise.allSettled(calls);
		}
	});

	it("MULTI: an MCP form from one scope's call is presented in that scope's presentation", async () => {
		// Given a modern server asking each call for input, and scopes A and B with their own presentations.
		const script = new MrtrScript([inputResult("a"), undefined, inputResult("b")]);
		const server = await startMrtrServer(script);
		closers.push(server.close);
		const inputA = vi.fn(async () => "from-A");
		const inputB = vi.fn(async () => "from-B");
		const tuiA = mrtrTui(undefined, inputA);
		const tuiB = mrtrTui(undefined, inputB);
		closers.push(async () => {
			tuiA.lose();
			tuiB.lose();
		});
		const servers = { mr: { type: "http", url: server.url, auth: false, exposure: "direct" } };
		const { a, b, attach, call } = await runtime({ uis: [tuiA.ui, tuiB.ui], servers });
		await attach(a);
		await attach(b);

		// When A calls, then B calls.
		await call(a, "mcp_mr_fixture");
		await call(b, "mcp_mr_fixture");

		// Then each form was presented by its own scope and answered the call it belongs to.
		expect(inputA).toHaveBeenCalledOnce();
		expect(inputB).toHaveBeenCalledOnce();
		expect(script.requests[1]?.params).toHaveProperty(["inputResponses", "question", "content", "value"], "from-A");
		expect(script.requests[3]?.params).toHaveProperty(["inputResponses", "question", "content", "value"], "from-B");
	});

	it("MULTI: a scope's skills stay its own when another scope's turn lists other skills", async () => {
		// Given scope A whose turn lists skill alpha (declaring server s), then scope B whose turn lists only beta.
		const rt = await runtime({ uis: plainUis() });
		const alpha = writeSkill(rt.agentDir, "alpha", { s: { command: "unused", includeTools: ["t"] } });
		const activate = revealSpies(rt);
		await rt.attach(rt.a);
		await rt.attach(rt.b);
		await startTurn(rt.a, [alpha]);
		await startTurn(rt.b, [writeSkill(rt.agentDir, "beta")]);

		// When A loads alpha.
		await rt.a.runner.emitInput("/skill:alpha", undefined, "interactive");

		// Then alpha's tools are revealed for A.
		expect(activate).toHaveBeenCalledWith(["mcp_s_t"], expect.anything());
	});

	it("MULTI: one scope loading a skill does not use up another scope's reveal of it", async () => {
		// Given scopes A and B whose turns both list skill alpha.
		const rt = await runtime({ uis: plainUis() });
		const alpha = writeSkill(rt.agentDir, "alpha", { s: { command: "unused", includeTools: ["t"] } });
		const activate = revealSpies(rt);
		await rt.attach(rt.a);
		await rt.attach(rt.b);
		await startTurn(rt.a, [alpha]);
		await startTurn(rt.b, [alpha]);

		// When A loads alpha, then B loads it.
		await rt.a.runner.emitInput("/skill:alpha", undefined, "interactive");
		await rt.b.runner.emitInput("/skill:alpha", undefined, "interactive");

		// Then each scope's load revealed it.
		expect(activate).toHaveBeenCalledTimes(2);
	});

	it("MULTI: after a later scope attaches, every scope's MCP calls are still served", async () => {
		// Given scopes A and B of one runtime, A attached first.
		const { a, b, attach, call } = await runtime({ uis: plainUis(), servers: await legacyServer("echo") });
		await attach(a);
		await attach(b);

		// When A calls, then B calls.
		// Then both are served, neither refused as another session's call.
		expect(await call(a, "mcp_fx_echo", { value: "A" })).toBe(JSON.stringify({ value: "A" }));
		expect(await call(b, "mcp_fx_echo", { value: "B" })).toBe(JSON.stringify({ value: "B" }));
	});

	it("keeps a started session's form in its own UI, as with one session", async () => {
		// Given one session started the usual way, in its first turn.
		const form = answering("only");
		const { a, call, service } = await runtime({ uis: [form.ui], servers: await legacyServer("elicit") });
		await a.runner.emit({ type: "session_start", reason: "startup" });
		await service.whenAttachSettled(10_000);
		await startTurn(a, []);

		// When its call asks for input.
		// Then the form opens in its UI.
		expect(await call(a, "mcp_fx_elicit")).toContain("only");
		expect(form.input).toHaveBeenCalledOnce();
	});
});

// The skill's own servers are not under test: attaching them is a no-op and the runtime lists one tool of server s.
function revealSpies(rt: McpScopedRuntime) {
	vi.spyOn(rt.service, "attachSkillMcpServers").mockResolvedValue([]);
	vi.spyOn(rt.service, "getTierBSearchable").mockReturnValue([{ name: "mcp_s_t", toolName: "t", server: "s" }]);
	return vi.spyOn(rt.service, "activateSkillMcpTools").mockImplementation(() => undefined);
}
