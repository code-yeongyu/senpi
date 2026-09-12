import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

it("admits question progress while the session is closing", async () => {
	const host = await startWorkerHost();
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"]),
			cwd: host.cwd,
			agentDir: join(host.scratch, "agent"),
			appMode: "rpc",
		},
		closeGraceMs: 1000,
		now: Date.now,
	});
	let sessionId: string | undefined;
	try {
		const opened = await registry.openSession({ cwd: host.cwd });
		sessionId = opened.sessionId;
		const closing = registry.beginClose(sessionId);
		expect(closing.state).toBe("closing");
		expect(registry.getForCommand(sessionId, "extension_ui_progress")).toBe(closing);
		expect(() => registry.getForCommand(sessionId!, "prompt")).toThrow("session_closing");
	} finally {
		if (sessionId) await registry.closeMarked(sessionId);
		await host.dispose();
	}
}, 60_000);

it("keeps responses and interactive extension UI requester-only across IPC", async () => {
	const host = await startWorkerHost(
		`export default function (pi) {
		pi.registerCommand("ask", { description: "test UI", handler: async (_args, ctx) => {
			await ctx.ui.confirm("test", "confirm");
		} });
	}`,
		{ socket: true },
	);
	try {
		const a = await host.connect();
		const b = await host.connect();
		const opened = await a.request({ type: "open_session", cwd: host.cwd });
		expect(opened.success).toBe(true);
		const attached = await b.request({
			type: "open_session",
			cwd: host.cwd,
			sessionPath: opened.data?.state?.sessionFile,
		});
		expect(attached.data?.attached).toBe(true);
		const before = b.records.length;
		await a.request({ type: "get_state", sessionId: opened.data?.sessionId });
		await b.request({ type: "list_sessions" });
		expect(b.records.slice(before).filter((record) => record.command === "get_state")).toHaveLength(0);
		const question = a.wait((record) => record.type === "extension_ui_request" && record.method === "confirm");
		const prompt = a.request({ type: "prompt", sessionId: opened.data?.sessionId, message: "/ask" });
		const ui = await question;
		await b.request({ type: "list_sessions" });
		expect(
			b.records.filter((record) => record.type === "extension_ui_request" && record.method === "confirm"),
		).toHaveLength(0);
		a.send({ type: "extension_ui_response", sessionId: opened.data?.sessionId, id: ui.id, confirmed: true });
		expect((await prompt).success).toBe(true);
		await a.request({ type: "close_session", sessionId: opened.data?.sessionId });
		const stillAttached = await b.request({ type: "get_state", sessionId: attached.data?.sessionId });
		expect(stillAttached.success).toBe(true);
	} finally {
		await host.dispose();
	}
}, 60_000);

it("reserves a switch target before its append-side normalization and keeps both owners intact on denial", async () => {
	const host = await startWorkerHost();
	const target = join(host.scratch, "target.jsonl");
	await writeFile(
		target,
		`${JSON.stringify({ type: "session", version: 3, id: "target-durable", timestamp: new Date(0).toISOString(), cwd: host.cwd })}\n`,
	);
	try {
		const a = await host.request({ type: "open_session", cwd: host.cwd });
		const b = await host.request({ type: "open_session", cwd: host.cwd, sessionPath: target });
		expect(a.success).toBe(true);
		expect(b.success).toBe(true);
		const before = await readFile(target, "utf8");
		const denied = await host.request({ type: "switch_session", sessionId: a.data?.sessionId, sessionPath: target });
		expect(denied.success).toBe(false);
		expect(await readFile(target, "utf8")).toBe(before);
		const stateA = await host.request({ type: "get_state", sessionId: a.data?.sessionId });
		const stateB = await host.request({ type: "get_state", sessionId: b.data?.sessionId });
		expect(stateA.data?.sessionId).toBe(a.data?.state?.sessionId);
		expect(stateB.data?.sessionId).toBe("target-durable");
		const created = await host.request({ type: "new_session", sessionId: a.data?.sessionId });
		expect(created.success).toBe(true);
		const replaced = await host.request({ type: "get_state", sessionId: a.data?.sessionId });
		expect(replaced.success).toBe(true);
		expect(replaced.data?.sessionId).not.toBe(a.data?.state?.sessionId);
	} finally {
		await host.dispose();
	}
}, 60_000);

it("publishes the shared minimum width before acknowledging it and rerenders when a peer leaves", async () => {
	const host = await startWorkerHost(
		`export default function(pi) {
		pi.on('session_start', (_event,ctx)=>ctx.ui.setWidget('width',()=>({render:width=>[String(width)]})));
	}`,
		{ socket: true },
	);
	try {
		const a = await host.connect();
		const b = await host.connect();
		const opened = await a.request({ type: "open_session", cwd: host.cwd });
		const sessionId = opened.data?.sessionId;
		expect(opened.success).toBe(true);
		expect(
			(await b.request({ type: "open_session", cwd: host.cwd, sessionPath: opened.data?.state?.sessionFile })).data
				?.attached,
		).toBe(true);
		await a.request({ type: "set_client_info", sessionId, width: 120, capabilities: ["rendered_components"] });
		const minimum = a.wait(
			(record) => record.widgetKey === "width" && JSON.stringify(record.widgetLines) === '["60"]',
		);
		await b.request({ type: "set_client_info", sessionId, width: 60, capabilities: ["rendered_components"] });
		await minimum;
		expect(
			b.records.some((record) => record.widgetKey === "width" && JSON.stringify(record.widgetLines) === '["60"]'),
		).toBe(true);
		const widened = a.wait(
			(record) => record.widgetKey === "width" && JSON.stringify(record.widgetLines) === '["120"]',
		);
		await b.request({ type: "close_session", sessionId });
		await widened;
	} finally {
		await host.dispose();
	}
}, 60_000);

it("starts real session workers under Node as well as Bun", async () => {
	const host = await startWorkerHost(undefined, { node: true });
	try {
		const opened = await host.request({ type: "open_session", cwd: host.cwd });
		expect(opened.success).toBe(true);
		const state = await host.request({ type: "get_state", sessionId: opened.data?.sessionId });
		expect(state.success).toBe(true);
		expect(state.data?.sessionId).toBe(opened.data?.state?.sessionId);
	} finally {
		await host.dispose();
	}
}, 60_000);

it.each(["answered", "comment-submitted"] as const)(
	"broadcasts question prompts across IPC and hydrates a late attachment (%s)",
	async (outcome) => {
		const host = await startWorkerHost(
			`export default function(pi) {
 pi.registerCommand("ask-question", {description: "question fixture", handler: async (_args, ctx) => {
 const result = await ctx.ui.question({requestId: "tool-question", waitForAnswer: true, timeoutMs: 60000,
 questions: ["q1", "q2"].map(id => ({id, header: id, question: id, options: [{label: "A"}, {label: "B"}], multiSelect: false}))});
 ctx.ui.notify(JSON.stringify(result));
 }}); }`,
			{ socket: true },
		);
		try {
			const a = await host.connect();
			const b = await host.connect();
			const opened = await a.request({ type: "open_session", cwd: host.cwd, capabilities: ["question"] });
			const sessionId = opened.data?.sessionId;
			await a.request({ type: "set_client_info", sessionId, capabilities: ["question"] });
			await b.request({ type: "open_session", cwd: host.cwd, sessionPath: opened.data?.state?.sessionFile });
			const qa = a.wait((r) => r.type === "extension_ui_request" && r.method === "question");
			const qb = b.wait((r) => r.type === "extension_ui_request" && r.method === "question");
			const prompt = a.request({ type: "prompt", sessionId, message: "/ask-question" });
			const frame = await qa;
			expect((await qb).id).toBe(frame.id);
			const c = await host.connect();
			const replay = c.wait((r) => r.type === "extension_ui_request" && r.method === "question");
			const attached = await c.request({
				type: "open_session",
				cwd: host.cwd,
				sessionPath: opened.data?.state?.sessionFile,
			});
			expect(attached.data?.state?.pendingQuestions).toEqual([expect.objectContaining({ id: frame.id })]);
			expect((await replay).id).toBe(frame.id);
			const updated = a.wait((r) => r.type === "question_updated");
			b.send({ type: "extension_ui_progress", sessionId, id: frame.id, answers: { q1: { selected: ["A"] } } });
			expect((await updated).remainingMs).toBeGreaterThan(0);
			// A submission with neither an answer nor a comment carries no decision: it is
			// rejected and the question stays pending for every attachment.
			const incomplete = b.wait((r) => r.error === "question_incomplete");
			b.send({
				type: "extension_ui_response",
				sessionId,
				id: frame.id,
				answers: {},
				comment: "",
			});
			await incomplete;
			const resolved = [a, b, c].map((peer) =>
				peer.wait((r) => r.type === "question_resolved" && r.id === frame.id),
			);
			// A partial answer map is a decision on every surface (ask-user/pending.ts): it
			// resolves the question as answered and reports the ids left unanswered.
			const answers = outcome === "answered" ? { q1: { selected: ["A"] } } : {};
			const comment = outcome === "answered" ? "" : "do it";
			b.send({ type: "extension_ui_response", sessionId, id: frame.id, answers, comment });
			for (const record of await Promise.all(resolved)) {
				expect(record).toMatchObject({
					outcome,
					answers,
					comment,
					unanswered: outcome === "answered" ? ["q2"] : ["q1", "q2"],
				});
			}
			expect((await prompt).success).toBe(true);
			const late = b.wait((r) => r.error === "question_already_resolved");
			b.send({ type: "extension_ui_response", sessionId, id: frame.id, answers: {}, comment: "do it" });
			await late;
			expect(c.records.filter((r) => r.method === "question")).toHaveLength(1);
			const state = await c.request({ type: "get_state", sessionId });
			expect(state.data?.pendingQuestions).toEqual([]);
		} finally {
			await host.dispose();
		}
	},
	60_000,
);
