import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { raceTerminalSecretInput } from "../../src/modes/interactive/terminal-sealed-secrets.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { closeAccountHosts, issuer } from "./fixtures/presenter-account-host.ts";
import { terminalPresenter } from "./fixtures/presenter-terminal.ts";
import { canaryValue, leaked } from "./fixtures/secret-canary.ts";
import { secretHostIssuer } from "./fixtures/secret-host-issuer.ts";
import { holder, records, sealedHost } from "./fixtures/secret-sealed-host.ts";
import { cancelAnswer, requestHash, valueAnswer, type AnswerIds } from "./fixtures/secret-sealed-presenter.ts";

// D11 secret phase S5-5 (senpi#4249), design 8.3: a synthetic canary answered through the real presenter control and
// a fake ES256 issuer. Neither the canary nor its ciphertext, enc or step-up token may reach any capture other than
// the answering holder's own connection: the raiser and observer lanes, the holder's received records, the terminal's
// feeds, session entries and session file.

const open: Array<() => Promise<void>> = [];
beforeAll(() => initTheme("dark"));
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
	vi.useRealTimers();
	for (const close of open.splice(0).reverse()) await close();
	await closeAccountHosts();
});

type Wire = Record<string, unknown>;
const flush = async () => {
	for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setImmediate(resolve));
};

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
	const request = records(phone.lines, "mcp_presenter_secret_request")[0];
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
		return { frame, secrets: [canary, String(frame.ct), String(frame.enc)], tokens: [stepup] };
	};
	const send = async (frame: Wire) => {
		setup.host.writer.withConnection(phone.id, () => setup.host.writer.handleMcpForm(frame));
		await flush();
	};
	const captures = () => [setup.host.lines.join("\n"), observer.lines.join("\n"), phone.lines.join("\n")];
	return { ...setup, phone, request, raised, req, state, sealedValue, send, captures };
}

const scan = (captures: readonly string[], secrets: readonly string[], tokens: readonly string[] = []) =>
	captures.map((capture) => leaked(capture, secrets, tokens) ?? "clean");

it("canary: an answered sealed prompt leaks nothing to the raiser, observer or holder captures", async () => {
	const p = await inProcess();
	const canary = canaryValue();
	const { frame, secrets, tokens } = p.sealedValue(canary, "answer-1");
	await p.send(frame);
	expect(p.state.value).toBe(canary);
	expect(scan(p.captures(), secrets, tokens)).toEqual(["clean", "clean", "clean"]);
});

it("canary: a replayed winning frame and a losing value answer leak nothing", async () => {
	const p = await inProcess();
	const first = p.sealedValue(canaryValue(), "answer-1");
	await p.send(first.frame);
	await p.send(first.frame);
	const late = p.sealedValue(canaryValue(), "answer-2");
	await p.send(late.frame);
	expect(scan(p.captures(), [...first.secrets, ...late.secrets], [...first.tokens, ...late.tokens])).toEqual([
		"clean",
		"clean",
		"clean",
	]);
});

it("canary: a value that loses the race to the raiser, or arrives after a cancel, is never seen anywhere", async () => {
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
	expect(scan(lost.captures(), loser.secrets, loser.tokens)).toEqual(["clean", "clean", "clean"]);

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
	expect(scan(cancelled.captures(), after.secrets, after.tokens)).toEqual(["clean", "clean", "clean"]);
});

it("canary: a value that arrives after the prompt timed out is never opened or seen", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const p = await inProcess({ timeout: 30_000 });
	vi.advanceTimersByTime(24 * 3_600_000);
	await flush();
	const late = p.sealedValue(canaryValue(), "answer-1");
	await p.send(late.frame);
	expect(p.state.value).toBeUndefined();
	expect(scan(p.captures(), late.secrets, late.tokens)).toEqual(["clean", "clean", "clean"]);
});

it("canary: a terminal session's sealed answer leaks nothing to its feeds, session entries or session file", async () => {
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
	const canary = canaryValue();
	const result = raceTerminalSecretInput(t.local.sealed, () => new Promise(() => {}), "API key", undefined, {
		secret: true,
	});
	const request = await desktop.waitFor((record) => record.type === "mcp_presenter_secret_request");
	const jkt = String(
		JSON.parse(Buffer.from(String(request.hostToken).split(".")[1] ?? "", "base64url").toString("utf8")).cnf?.jkt,
	);
	const req = requestHash(request, jkt);
	const stepup = secret.stepUp(device.publicKey, req, { dev: "device-a" });
	const ids: AnswerIds = {
		id: "line-1",
		req,
		principalId: String(enrolled.principalId),
		grantId: String((enrolled.acquired as Wire).grantId),
		uiRequestId: String(request.uiRequestId),
		answerId: "answer-1",
	};
	const frame = valueAnswer(ids, request, stepup, canary, device.privateKey);
	await desktop.request(frame);
	expect(await result).toBe(canary);
	for (const client of [observer, bystander]) await client.request({ type: "get_state" });
	const secrets = [canary, String(frame.ct), String(frame.enc)];
	const file = t.harness.session.sessionFile;
	const captures = [
		observer.bytes,
		bystander.bytes,
		JSON.stringify(t.harness.session.sessionManager.getEntries()),
		file !== undefined && existsSync(file) ? readFileSync(file, "utf8") : "",
		desktop.records
			.filter((record) => record.type !== "mcp_presenter_secret_request")
			.map((r) => JSON.stringify(r))
			.join("\n"),
	];
	expect(scan(captures, secrets, [stepup])).toEqual(["clean", "clean", "clean", "clean", "clean"]);
});
