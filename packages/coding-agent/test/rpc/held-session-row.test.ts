import { once } from "node:events";
import { watch } from "node:fs";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSync, Visitor } from "oxc-parser";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startWorkerHost } from "../suite/rpc-worker-host-support.ts";
import { SESSION_ROW_HOLD_KEYS, sessionRowHold } from "../../src/modes/rpc/session-row-hold.ts";
import { HOST_DRAIN_HOLD_KEY } from "../../src/core/host-restart-continuation.ts";
import { CLOSING_HOLD_KEY } from "../../src/core/session-closed.ts";
import { startHost } from "../suite/rpc-delegated-host-support.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

it("classifies each addHold producer in src/modes/rpc/session-row-hold.ts", () => {
	const cwd = fileURLToPath(new URL("../../src/", import.meta.url));
	const known = Object.entries(SESSION_ROW_HOLD_KEYS).flatMap(([kind, keys]) => keys.map((key) => `${kind}/${key}`));
	const found = new Set<string>();
	for (const path of globSync("**/*.ts", { cwd })) {
		const text = readFileSync(join(cwd, path), "utf8");
		if (!text.includes("addHold")) continue;
		const source = parseSync(path, text);
		const span = (n: { start: number; end: number } | undefined) => n && text.slice(n.start, n.end);
		new Visitor({
			CallExpression(node) {
				if (
					node.callee.type === "MemberExpression" &&
					node.callee.property.type === "Identifier" &&
					node.callee.property.name === "addHold"
				) {
					const [kindArg, options] = node.arguments;
					// Ledger rollback re-adds the same restored value; it cannot introduce a new producer.
					if (
						path.endsWith("engine-turn-hold.ts") &&
						span(kindArg) === "kind" &&
						span(options) === "{ key, data }"
					)
						return;
					const kind = kindArg?.type === "Literal" ? kindArg.value : "<unclassified>";
					const field =
						options?.type === "ObjectExpression"
							? options.properties.find((p) => p.type === "Property" && span(p.key) === "key")
							: undefined;
					const key = field?.type === "Property" ? field.value : undefined;
					const expression = span(key);
					const family = !options
						? kind
						: key?.type === "Literal"
							? key.value
							: expression === "HOST_DRAIN_HOLD_KEY"
								? HOST_DRAIN_HOLD_KEY
								: expression === "CLOSING_HOLD_KEY"
									? CLOSING_HOLD_KEY
									: expression === "INHERITED_KEY"
										? /const INHERITED_KEY = "([^"]+)"/.exec(text)?.[1]
										: key?.type === "TemplateLiteral" &&
											  key.quasis[0]?.value.raw === "session_hold:" &&
											  key.quasis[1]?.value.raw === "" &&
											  key.expressions.length === 1 &&
											  span(key.expressions[0]) === "localSeq"
											? "session_hold"
											: undefined;
					if (kind === "run_fence" && expression === "fenceKey(runRef)") return;
					expect(
						known,
						`${path}: ${span(node)} needs classification in src/modes/rpc/session-row-hold.ts`,
					).toContain(`${kind}/${family}`);
					found.add(`${kind}/${family}`);
				}
			},
		}).visit(source.program);
	}
	expect([...found].sort()).toEqual(known.sort());
});

it("omits private restored hold fields from the list and the subscriber snapshot", async () => {
	const host = await startHost();
	try {
		const file = SessionManager.create(host.cwd, host.scratch);
		file.appendMessage({ role: "user", content: "seed", timestamp: 1 });
		file.appendMessage(fauxAssistantMessage("seeded"));
		const marker = "private-marker-" + "x".repeat(8192);
		file.appendCustomEntry("session-hold", {
			op: "add",
			pauseSeq: 2,
			kind: "session_hold",
			key: marker,
			at: marker,
			data: marker,
		});
		const peer = await host.proven();
		const opened = await peer.send({ type: "open_session", sessionPath: file.getSessionFile(), attended: false });
		expect(opened.success).toBe(true);
		const list = await peer.send({ type: "list_sessions" });
		const status = await peer.send({ type: "subscribe_sessions" });
		for (const [reply, rows] of [
			[list, "sessions"],
			[status, "snapshot"],
		] as const) {
			const payload = JSON.stringify(reply);
			expect(payload).not.toContain("private-marker");
			expect(payload.length).toBeLessThan(8192);
			const data = reply.data as Record<string, { hold?: unknown }[]>;
			expect(data[rows]?.[0]?.hold).toEqual({ kind: "session_hold", key: "other", queueDepth: 0 });
		}
	} finally {
		await host.dispose();
	}
});

it("publishes only fixed keys of the matching kind from the restored ledger", () => {
	const since = "2026-11-27T00:00:00.000Z";
	for (const key of ["caller-defined", "inherited_hold"]) {
		const row = sessionRowHold(
			[{ kind: "session_hold", key, since, data: "private", sourceCounts: { private: 1 } }],
			() => 0,
		);
		expect(row).toEqual({ kind: "session_hold", key: "other", since, queueDepth: 0 });
	}
	expect(
		sessionRowHold([{ kind: "session_hold", key: "session_hold:42", since, sourceCounts: {} }], () => 1)?.key,
	).toBe("session_hold");
	expect(
		sessionRowHold([{ kind: "run_fence", key: "run_fence:task:private", since, sourceCounts: {} }], () => 0),
	).toBeUndefined();
});

const faux = new URL("../../../ai/dist/providers/faux.js", import.meta.url).href;
const extension = `import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(faux)};
export default function(pi) {
  const f = fauxProvider({ api: "row-test", provider: "row-test" });
  f.setResponses([fauxAssistantMessage([fauxToolCall("row_gate", {})], { stopReason: "toolUse" })]);
  pi.registerProvider(f.provider);
  pi.registerTool({name:"row_gate", label:"Gate", description:"Wait for process termination", parameters:{type:"object",properties:{}}, execute:()=>{writeFileSync("entered","");return new Promise(()=>{});}});
}`;

it.each(["in-process", "worker"] as const)(
	"the %s runtime lists a session killed during a tool call with its interrupted hold and waiting deliveries",
	async (sessionRuntime) => {
		const opts = { node: true, sessionRuntime: "in-process", waitForReady: true } as const;
		const source = await startWorkerHost(extension, opts);
		try {
			const opened = await source.request({ type: "open_session", provider: "row-test", modelId: "faux-1" });
			expect(opened.success, opened.error).toBe(true);
			const sessionId = opened.data?.sessionId;
			const row = (await source.request({ type: "list_sessions" })).data?.sessions?.find(
				(s) => s.sessionId === sessionId,
			);
			if (!row?.sessionPath) throw new Error("no persisted session to reopen");
			expect(row).not.toHaveProperty("hold");
			const watcher = watch(source.cwd);
			try {
				const entered = new Promise<void>((resolve) =>
					watcher.on("change", (_, name) => {
						if (name === "entered") resolve();
					}),
				);
				source.send({ type: "prompt", sessionId, message: "enter gate" });
				await entered;
			} finally {
				watcher.close();
			}
			const exited = once(source.child, "exit");
			source.child.kill("SIGKILL");
			expect((await exited)[1]).toBe("SIGKILL");

			const successor = await startWorkerHost(extension, { ...opts, sessionRuntime });
			try {
				expect((await successor.request({ type: "get_protocol_info" })).data?.capabilities).toContain(
					"session_row_hold",
				);
				const reopened = await successor.request({
					type: "open_session",
					sessionPath: row.sessionPath,
					cwd: join(source.scratch, "cwd"),
					attended: false,
				});
				expect(reopened.success, reopened.error).toBe(true);
				const id = reopened.data?.sessionId;
				const point = await successor.request({ type: "get_state", sessionId: id });
				expect(point.data).toMatchObject({
					paused: true,
					holds: expect.arrayContaining([expect.objectContaining({ key: "interrupted-run" })]),
				});
				for (const [n, kind] of [
					[1, "held"],
					[2, "held"],
					[2, "already_admitted"],
					[3, "held"],
				] as const) {
					expect(
						await successor.request({
							type: "admit_external_message",
							sessionId: id,
							deliveryId: `msg-${n}`,
							text: `message ${n}`,
							sender: { kind: "agent", session_id: "peer" },
							deliverAs: "followUp",
						}),
					).toMatchObject({ success: true, data: { kind } });
				}
				const listed = (await successor.request({ type: "list_sessions" })).data?.sessions?.find(
					(s) => s.sessionId === id,
				);
				const holds = point.data?.holds as Array<{ key: string; since: string }>;
				const expected = {
					kind: "session_hold",
					key: "interrupted-run",
					since: holds.find((h) => h.key === "interrupted-run")?.since,
					queueDepth: 3,
				};
				expect(listed?.hold).toEqual(expected);
			} finally {
				await successor.dispose();
			}
		} finally {
			await source.dispose();
		}
	},
);
