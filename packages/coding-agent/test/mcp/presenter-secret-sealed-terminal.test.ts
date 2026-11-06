import { afterEach, beforeAll, expect, it } from "vitest";
import { raceTerminalSecretInput } from "../../src/modes/interactive/terminal-sealed-secrets.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { issuer } from "./fixtures/presenter-account-host.ts";
import { terminalPresenter } from "./fixtures/presenter-terminal.ts";
import { secretHostIssuer } from "./fixtures/secret-host-issuer.ts";
import { cancelAnswer, requestHash, valueAnswer } from "./fixtures/secret-sealed-presenter.ts";

// D11 secret phase S5-5 (senpi#4249): terminal (S3-6b) parity. A real TUI control endpoint with an account authority;
// desktops enroll over its control socket and answer on their terminal connection. The terminal's local input is a
// controllable promise in place of the TUI component.

const open: Array<() => Promise<void>> = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const close of open.splice(0).reverse()) await close();
});

type Wire = Record<string, unknown>;

const hostJktOf = (request: Wire): string =>
	String(
		JSON.parse(Buffer.from(String(request.hostToken).split(".")[1] ?? "", "base64url").toString("utf8")).cnf?.jkt ??
			"",
	);

async function sealedTerminal() {
	const secret = secretHostIssuer(issuer);
	const t = await terminalPresenter({ account: secret.authority });
	open.push(t.close);
	return { t, secret };
}

async function holder(
	t: Awaited<ReturnType<typeof terminalPresenter>>,
	secret: ReturnType<typeof secretHostIssuer>,
	features = ["secret_input_v1"],
) {
	const desktop = await t.client();
	const enrolled = await t.enrollDesktop(desktop, features);
	expect(enrolled.acquired).toMatchObject({ type: "mcp_presenter_acquired" });
	const { device } = enrolled;
	if (!device) throw new Error("The desktop did not enroll");
	await secret.mints.at(-1)?.done;
	return { desktop, enrolled: { ...enrolled, device } };
}

function localInput() {
	const answer = Promise.withResolvers<string | undefined>();
	const seen: { signal?: AbortSignal } = {};
	const input = (opts: { signal?: AbortSignal } | undefined) => {
		seen.signal = opts?.signal;
		opts?.signal?.addEventListener("abort", () => answer.resolve(undefined), { once: true });
		return answer.promise;
	};
	return { input, answer, seen };
}

async function hostTokenReady(t: Awaited<ReturnType<typeof terminalPresenter>>) {
	for (let turn = 0; turn < 50 && !t.local.sealed; turn++) await new Promise((resolve) => setImmediate(resolve));
	if (!t.local.sealed) throw new Error("No sealed route on the terminal");
	return t.local.sealed;
}

function ids(enrolled: Awaited<ReturnType<typeof holder>>["enrolled"], request: Wire, req: string, answerId = "a1") {
	return {
		id: `line-${answerId}`,
		req,
		principalId: String(enrolled.principalId),
		grantId: String((enrolled.acquired as Wire).grantId),
		uiRequestId: String(request.uiRequestId),
		answerId,
	};
}

it("a TUI secret prompt with an enrolled sealed holder is offered to it, and a sealed answer wins and dismisses the local input", async () => {
	const { t, secret } = await sealedTerminal();
	const { desktop, enrolled } = await holder(t, secret);
	const sealed = await hostTokenReady(t);
	const local = localInput();
	const result = raceTerminalSecretInput(sealed, local.input, "API key", undefined, { secret: true });
	const request = await desktop.waitFor((record) => record.type === "mcp_presenter_secret_request");
	expect(request).toMatchObject({ sessionId: t.sessionId, title: "API key" });
	const req = requestHash(request, hostJktOf(request));
	const frame = valueAnswer(
		ids(enrolled, request, req),
		request,
		secret.stepUp(enrolled.device.publicKey, req, { dev: "device-a" }),
		"terminal-value",
		enrolled.device.privateKey,
	);
	const reply = desktop.waitFor((record) => record.type === "mcp_presenter_secret_reply");
	await desktop.request(frame);
	expect(await reply).toMatchObject({ disposition: "applied" });
	expect(await result).toBe("terminal-value");
	expect(local.seen.signal?.aborted).toBe(true);
	expect(await desktop.waitFor((record) => record.type === "mcp_presenter_secret_settled")).toMatchObject({
		outcome: "answered",
		elsewhere: false,
	});
});

it("the terminal's own answer wins first: holders settle elsewhere and a later sealed answer is already_answered", async () => {
	const { t, secret } = await sealedTerminal();
	const { desktop, enrolled } = await holder(t, secret);
	const sealed = await hostTokenReady(t);
	const local = localInput();
	const result = raceTerminalSecretInput(sealed, local.input, "API key", undefined, { secret: true });
	const request = await desktop.waitFor((record) => record.type === "mcp_presenter_secret_request");
	local.answer.resolve("typed-locally");
	expect(await result).toBe("typed-locally");
	expect(await desktop.waitFor((record) => record.type === "mcp_presenter_secret_settled")).toMatchObject({
		outcome: "answered",
		elsewhere: true,
	});
	const req = requestHash(request, hostJktOf(request));
	const late = cancelAnswer(ids(enrolled, request, req, "late"), enrolled.device.privateKey);
	const reply = desktop.waitFor((record) => record.type === "mcp_presenter_secret_reply");
	await desktop.request(late);
	expect(await reply).toMatchObject({ error: "already_answered" });
});

it("without a sealed holder the terminal's input runs alone with its own options", async () => {
	const { t, secret } = await sealedTerminal();
	const plain = await holder(t, secret, ["elsewhere_v1"]);
	const local = localInput();
	const opts = { secret: true };
	const result = raceTerminalSecretInput(t.local.sealed, local.input, "API key", undefined, opts);
	local.answer.resolve("only-local");
	expect(await result).toBe("only-local");
	expect(local.seen.signal).toBeUndefined();
	expect(plain.desktop.records.some((record) => record.type === "mcp_presenter_secret_request")).toBe(false);
});

// senpi#6062: the local input can fail after the holder has received the offer.
it("a rejecting local input cancels the sealed race immediately and dismisses the input", async () => {
	const { t, secret } = await sealedTerminal();
	const { desktop } = await holder(t, secret);
	const sealed = await hostTokenReady(t);
	const local = localInput();
	const result = raceTerminalSecretInput(sealed, local.input, "API key", undefined, { secret: true });
	await desktop.waitFor((record) => record.type === "mcp_presenter_secret_request");
	local.answer.reject(new Error("injected local input failure"));
	expect(await result).toBeUndefined();
	expect(local.seen.signal?.aborted).toBe(true);
	expect(await desktop.waitFor((record) => record.type === "mcp_presenter_secret_settled")).toMatchObject({
		outcome: "cancelled",
		elsewhere: true,
	});
});

it("a sealed answer from a connection that is not a holder is refused, and the reply reaches that connection only", async () => {
	const { t, secret } = await sealedTerminal();
	const { desktop, enrolled } = await holder(t, secret);
	const bystander = await t.client();
	const sealed = await hostTokenReady(t);
	const local = localInput();
	void raceTerminalSecretInput(sealed, local.input, "API key", undefined, { secret: true });
	const request = await desktop.waitFor((record) => record.type === "mcp_presenter_secret_request");
	const req = requestHash(request, hostJktOf(request));
	const frame = valueAnswer(
		ids(enrolled, request, req),
		request,
		secret.stepUp(enrolled.device.publicKey, req, { dev: "device-a" }),
		"v",
		enrolled.device.privateKey,
	);
	const reply = bystander.waitFor((record) => record.type === "mcp_presenter_secret_reply");
	await bystander.request(frame);
	expect(await reply).toMatchObject({ error: "secret_answer_refused" });
	expect(desktop.records.some((record) => record.type === "mcp_presenter_secret_reply")).toBe(false);
	local.answer.resolve(undefined);
});
