import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { raceTerminalSecretInput } from "../../src/modes/interactive/terminal-sealed-secrets.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { closeAccountHosts, issuer } from "./fixtures/presenter-account-host.ts";
import { terminalPresenter } from "./fixtures/presenter-terminal.ts";
import { canaryValue, leaked, sealedNeedles } from "./fixtures/secret-canary.ts";
import { secretHostIssuer } from "./fixtures/secret-host-issuer.ts";
import { holder, records, sealedHost } from "./fixtures/secret-sealed-host.ts";
import { type AnswerIds, cancelAnswer, requestHash, valueAnswer } from "./fixtures/secret-sealed-presenter.ts";

// D11 secret phase S5-5 (senpi#4249), design 8.3: a synthetic canary answered through the real presenter control and
// a fake ES256 issuer. Neither the canary nor its ciphertext, enc (as wire strings and as raw bytes) or step-up token
// may reach any capture other than the answering holder's own request. Stores per runtime:
// - in-process RPC host (a writer without a session): the sole stdio lane, the raiser lane, an observer lane, the
//   holder's received records, host stdout/stderr;
// - terminal session (a real AgentSession): observer feeds, get_state, get_snapshot, session entries, the session
//   file (as bytes), the holder's received records, host stdout/stderr; every case runs here too;
// - worker isolate: in presenter-secret-sealed-worker.test.ts.
// senpi emits no trace records (no trace-record output exists in packages/coding-agent/src), so there is none to scan.

const open: Array<() => Promise<void>> = [];
const stdio: string[] = [];
beforeAll(() => initTheme("dark"));
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	stdio.length = 0;
	for (const stream of [process.stdout, process.stderr])
		vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdio.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		});
	for (const method of ["log", "info", "warn", "error", "debug"] as const)
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			stdio.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
		});
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const close of open.splice(0).reverse()) await close();
	await closeAccountHosts();
});

type Wire = Record<string, unknown>;
const flush = async () => {
	for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setImmediate(resolve));
};
const CLEAN = (n: number) => Array.from({ length: n }, () => "clean");
const scan = (captures: readonly (string | Buffer)[], secrets: readonly string[], tokens: readonly string[]) =>
	captures.map((capture) => leaked(capture, secrets, tokens) ?? "clean");

function idsFor(h: Awaited<ReturnType<typeof holder>>, request: Wire, req: string, answerId: string): AnswerIds {
	return {
		id: `line-${answerId}`,
		req,
		principalId: String(h.adopted.principalId),
		grantId: String(h.adopted.acquired?.grantId),
		uiRequestId: String(request.uiRequestId),
		answerId,
	};
}

async function inProcess(options: { readonly timeout?: number } = {}) {
	const setup = await sealedHost();
	const phone = await holder(setup.host, setup.secret, "phone");
	const observer = setup.host.presenter("observer");
	setup.host.writer.setConnectionCapabilities("human", [
		"interactive_user",
		"mcp_form_presenter_v1",
		"secret_input_v1",
	]);
	setup.host.writer.setConnectionCapabilities("observer", ["interactive_user", "raiser_notice_v1"]);
	const state: { value: string | undefined | null } = { value: null };
	void setup.requests
		.input("API key", undefined, options.timeout === undefined ? undefined : { timeout: options.timeout })
		.then((value) => {
			state.value = value;
		});
	const request = (await phone.recorded("mcp_presenter_secret_request"))[0];
	const raised = records(setup.host.lines, "extension_ui_request")[0];
	if (!request || !raised) throw new Error("No prompt");
	const req = requestHash(request, setup.host.control.sealed?.tokens.hostJkt ?? "");
	const sealedValue = (canary: string, answerId: string) => {
		const stepup = setup.secret.stepUp(phone.adopted.device.publicKey, req);
		const frame = valueAnswer(
			idsFor(phone, request, req, answerId),
			request,
			stepup,
			canary,
			phone.adopted.device.privateKey,
		);
		return { frame, secrets: [canary, ...sealedNeedles(frame)], tokens: [stepup] };
	};
	const send = async (frame: Wire) => {
		setup.host.writer.withConnection(phone.id, () => setup.host.writer.handleMcpForm(frame));
		await flush();
	};
	const captures = () => [
		setup.host.sole.join(""),
		setup.host.lines.join("\n"),
		observer.lines.join("\n"),
		phone.lines.filter((line) => !line.includes("mcp_presenter_secret_request")).join("\n"),
		stdio.join(""),
	];
	return { ...setup, phone, request, raised, req, state, sealedValue, send, captures };
}

it("canary, in-process: an answered sealed prompt leaks nothing to any store", async () => {
	const p = await inProcess();
	const canary = canaryValue();
	const { frame, secrets, tokens } = p.sealedValue(canary, "answer-1");
	await p.send(frame);
	expect(p.state.value).toBe(canary);
	expect(scan(p.captures(), secrets, tokens)).toEqual(CLEAN(5));
});

it("canary, in-process: a replayed winning frame and a losing value answer leak nothing", async () => {
	const p = await inProcess();
	const first = p.sealedValue(canaryValue(), "answer-1");
	await p.send(first.frame);
	await p.send(first.frame);
	const late = p.sealedValue(canaryValue(), "answer-2");
	await p.send(late.frame);
	expect(scan(p.captures(), [...first.secrets, ...late.secrets], [...first.tokens, ...late.tokens])).toEqual(CLEAN(5));
});

it("canary, in-process: a value that loses the race to the raiser, or arrives after a cancel, is never seen anywhere", async () => {
	const lost = await inProcess();
	lost.host.writer.withConnection("human", () =>
		lost.requests.respond({
			type: "extension_ui_response",
			id: "r1",
			uiRequestId: lost.raised.id,
			answerId: "r",
			secret: true,
			value: "raiser-value",
		}),
	);
	const loser = lost.sealedValue(canaryValue(), "answer-1");
	await lost.send(loser.frame);
	expect(scan(lost.captures(), loser.secrets, loser.tokens)).toEqual(CLEAN(5));

	const cancelled = await inProcess();
	await cancelled.send(
		cancelAnswer(
			idsFor(cancelled.phone, cancelled.request, cancelled.req, "cancel"),
			cancelled.phone.adopted.device.privateKey,
		),
	);
	const after = cancelled.sealedValue(canaryValue(), "answer-2");
	await cancelled.send(after.frame);
	expect(cancelled.state.value).toBeUndefined();
	expect(scan(cancelled.captures(), after.secrets, after.tokens)).toEqual(CLEAN(5));
});

it("canary, in-process: a value that arrives after the prompt timed out is never opened or seen", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const p = await inProcess({ timeout: 30_000 });
	vi.advanceTimersByTime(24 * 3_600_000);
	await flush();
	expect(p.state.value).toBeUndefined();
	const late = p.sealedValue(canaryValue(), "answer-1");
	await p.send(late.frame);
	expect(scan(p.captures(), late.secrets, late.tokens)).toEqual(CLEAN(5));
});

async function terminalSession() {
	vi.useRealTimers();
	const secret = secretHostIssuer(issuer);
	const t = await terminalPresenter({ account: secret.authority });
	open.push(t.close);
	const desktop = await t.client();
	const enrolled = await t.enrollDesktop(desktop, ["secret_input_v1"]);
	const device = enrolled.device;
	if (!device) throw new Error("The desktop did not enroll");
	await secret.mints.at(-1)?.done;
	const observer = await t.client(["interactive_user"]);
	const bystander = await t.client();
	await observer.request({ type: "subscribe", cursor: 0 });
	await bystander.request({ type: "subscribe_sessions", sessions: "all", mirror: "all" });
	const local = Promise.withResolvers<string | undefined>();
	const prompt = (opts: { secret: true; timeout?: number }) =>
		raceTerminalSecretInput(t.local.sealed, () => local.promise, "API key", undefined, opts);
	const requested = async () => {
		const request = await desktop.waitFor((record) => record.type === "mcp_presenter_secret_request");
		const token = String(request.hostToken).split(".")[1] ?? "";
		const req = requestHash(request, String(JSON.parse(Buffer.from(token, "base64url").toString("utf8")).cnf?.jkt));
		const ids = (answerId: string): AnswerIds => ({
			id: `line-${answerId}`,
			req,
			principalId: String(enrolled.principalId),
			grantId: String((enrolled.acquired as Wire).grantId),
			uiRequestId: String(request.uiRequestId),
			answerId,
		});
		const sealedValue = (canary: string, answerId: string) => {
			const stepup = secret.stepUp(device.publicKey, req, { dev: "device-a" });
			const frame = valueAnswer(ids(answerId), request, stepup, canary, device.privateKey);
			return { frame, secrets: [canary, ...sealedNeedles(frame)], tokens: [stepup] };
		};
		return { request, ids, sealedValue };
	};
	const send = (frame: Wire) => desktop.request(frame);
	const captures = async () => {
		const state = await observer.request({ type: "get_state" });
		const snapshot = await observer.request({ type: "get_snapshot" });
		await bystander.request({ type: "get_state" });
		const file = t.harness.session.sessionFile;
		return [
			observer.bytes,
			bystander.bytes,
			JSON.stringify(state),
			JSON.stringify(snapshot),
			JSON.stringify(t.harness.session.sessionManager.getEntries()),
			file !== undefined && existsSync(file) ? readFileSync(file) : Buffer.alloc(0),
			desktop.records
				.filter((record) => record.type !== "mcp_presenter_secret_request")
				.map((record) => JSON.stringify(record))
				.join("\n"),
			stdio.join(""),
		];
	};
	return { t, local, prompt, requested, send, captures, device };
}

it("canary, terminal: an answered and a replayed sealed answer leak nothing to any store", async () => {
	const s = await terminalSession();
	const canary = canaryValue();
	const result = s.prompt({ secret: true });
	const r = await s.requested();
	const answer = r.sealedValue(canary, "answer-1");
	expect(await s.send(answer.frame)).toMatchObject({ disposition: "applied" });
	expect(await result).toBe(canary);
	expect(await s.send({ ...answer.frame, id: "line-replay" })).toMatchObject({ disposition: "replay" });
	expect(scan(await s.captures(), answer.secrets, answer.tokens)).toEqual(CLEAN(8));
});

it("canary, terminal: a value that loses to the terminal's own input, or follows a cancel, leaks nothing", async () => {
	const lost = await terminalSession();
	const won = lost.prompt({ secret: true });
	const lr = await lost.requested();
	lost.local.resolve("typed-locally");
	expect(await won).toBe("typed-locally");
	const loser = lr.sealedValue(canaryValue(), "answer-1");
	expect(await lost.send(loser.frame)).toMatchObject({ error: "already_answered" });
	expect(scan(await lost.captures(), loser.secrets, loser.tokens)).toEqual(CLEAN(8));

	const cancelled = await terminalSession();
	const ended = cancelled.prompt({ secret: true });
	const cr = await cancelled.requested();
	await cancelled.send(cancelAnswer(cr.ids("cancel"), cancelled.device.privateKey));
	expect(await ended).toBeUndefined();
	const after = cr.sealedValue(canaryValue(), "answer-2");
	await cancelled.send(after.frame);
	expect(scan(await cancelled.captures(), after.secrets, after.tokens)).toEqual(CLEAN(8));
});

it("canary, terminal: a value that arrives after the prompt's deadline leaks nothing", async () => {
	const s = await terminalSession();
	const expired = s.prompt({ secret: true, timeout: 200 });
	const r = await s.requested();
	expect(await expired).toBeUndefined();
	const late = r.sealedValue(canaryValue(), "answer-1");
	await s.send(late.frame);
	expect(scan(await s.captures(), late.secrets, late.tokens)).toEqual(CLEAN(8));
});
