import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isRecord } from "../../src/core/extensions/builtin/mcp/modern/form-schema.ts";
import type { McpFormRequest } from "../../src/core/mcp-form-types.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { McpPresenterControl } from "../../src/modes/rpc/mcp-presenter-control.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { enrollmentRequest } from "./fixtures/presenter-enrollment.ts";

function records(socket: Socket) {
	const queued: Record<string, unknown>[] = [];
	const waiters: Array<(value: Record<string, unknown>) => void> = [];
	attachJsonlLineReader(socket, (line) => {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value)) throw new Error("Expected a private record");
		const waiter = waiters.shift();
		if (waiter) waiter(value);
		else queued.push(value);
	});
	return {
		send: (value: object) => socket.write(`${JSON.stringify(value)}\n`),
		next: () => {
			const value = queued.shift();
			return value
				? Promise.resolve(value)
				: new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve));
		},
	};
}

async function signedCommand(
	m: ReturnType<typeof records>,
	principalId: unknown,
	key: KeyObject,
	command: Record<string, unknown>,
) {
	m.send({ type: "challenge", principalId, backendGeneration: "backend", command });
	const challenge = await m.next();
	if (typeof challenge.transcript !== "string") throw new Error("Missing challenge");
	m.send({ type: "proof", signature: sign(null, Buffer.from(challenge.transcript), key).toString("hex") });
	return m.next();
}

// D11 S3-3b: `features` rides inside the signed acquire; only `elsewhere_v1` grants receive the negotiated records.
it("the signed acquire's features decide whether a grant receives mcp_form_settled; a malformed list is refused", async () => {
	const root = await mkdtemp(join(tmpdir(), "pcf-"));
	const writer = new SessionEventWriter(() => {});
	const authority = writer.enableMcpPresenters();
	const frames: Array<{ type?: unknown }> = [];
	writer.registerConnection("human", {
		writeRaw: (line) => frames.push(JSON.parse(line)),
		waitForBackpressure: async () => {},
	});
	writer.setConnectionCapabilities("human", ["interactive_user", "mcp_form_presenter_v1"]);
	writer.bindMcpForms("session", "durable", {}, () => {});
	writer.attachConnectionToSession("human", "session");
	const binding = writer.getMcpFormBinding("session");
	const connection = writer.getMcpPresenterConnection("human");
	if (!binding || !connection) throw new Error("Fixture binding missing");
	const context = authority.connectionContext(connection, "session");
	const control = new McpPresenterControl(
		writer,
		process.platform === "win32" ? `\\\\.\\pipe\\presenter-features-${randomUUID()}` : join(root, "c.sock"),
	);
	await control.listen();
	const bootstrapServer = createServer((socket) => control.bootstrap(socket));
	bootstrapServer.listen(0, "127.0.0.1");
	await once(bootstrapServer, "listening");
	const address = bootstrapServer.address();
	if (typeof address !== "object" || !address) throw new Error("Bootstrap listener missing");
	const bootstrap = connect(address.port, "127.0.0.1");
	const sockets: Socket[] = [bootstrap];
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const answerOneForm = async () => {
		const presentation = binding.capture();
		if (!presentation) throw new Error("No grant");
		const result = presentation.present({
			operationId: "operation",
			inputId: "input",
			round: 0,
			server: { label: "fixture", source: "user" },
			message: "fixture",
			schema: { type: "object", properties: {} },
			operationSignal: new AbortController().signal,
			presentationSignal: new AbortController().signal,
			deadlineMs: 10_000,
		});
		const request = frames.findLast((frame): frame is McpFormRequest => frame.type === "mcp_form_request");
		if (!request) throw new Error("No private request");
		const { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision } = request;
		const envelope = { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision };
		authority.receive(connection, { ...envelope, type: "mcp_form_presented" });
		authority.receive(connection, { ...envelope, type: "mcp_form_response", action: "accept", content: {} });
		await result;
	};
	try {
		const b = records(bootstrap);
		b.send({
			...enrollmentRequest(),
			publicKey: publicKey.export({ type: "spki", format: "pem" }),
			installationKeyId: createHash("sha256")
				.update(publicKey.export({ type: "spki", format: "der" }))
				.digest("hex"),
			backendGeneration: "backend",
		});
		const challenge = await b.next();
		if (typeof challenge.transcript !== "string") throw new Error("Missing challenge");
		b.send({ type: "proof", signature: sign(null, Buffer.from(challenge.transcript), privateKey).toString("hex") });
		const enrolled = await b.next();
		const management = connect(control.path);
		sockets.push(management);
		const m = records(management);
		const assign = {
			type: "mcp_presenter_assign",
			sessionId: "session",
			bindingEpoch: binding.epoch,
			purpose: "mcp_form",
		};
		expect(await signedCommand(m, enrolled.principalId, privateKey, assign)).toMatchObject({
			type: "mcp_presenter_assigned",
		});
		const acquire = {
			type: "mcp_presenter_acquire",
			...context,
			sessionId: "session",
			kind: "desktop",
			purpose: "mcp_form",
		};
		for (const features of ["elsewhere_v1", [7], Array.from({ length: 17 }, () => "x"), [""]])
			expect(
				await signedCommand(m, enrolled.principalId, privateKey, { ...acquire, id: "bad", features }),
			).toMatchObject({
				type: "mcp_presenter_error",
				error: "presenter_not_authorized",
			});
		expect(binding.capture()).toBeUndefined();
		const negotiated = await signedCommand(m, enrolled.principalId, privateKey, {
			...acquire,
			id: "negotiated",
			features: ["future_v9", "elsewhere_v1"],
		});
		expect(negotiated).toMatchObject({ type: "mcp_presenter_acquired", id: "negotiated" });
		await answerOneForm();
		expect(frames.filter((frame) => frame.type === "mcp_form_settled")).toHaveLength(1);
		expect(
			await signedCommand(m, enrolled.principalId, privateKey, {
				type: "mcp_presenter_revoke",
				id: "revoke",
				registrationId: negotiated.registrationId,
			}),
		).toMatchObject({ type: "mcp_presenter_revoked" });
		expect(await signedCommand(m, enrolled.principalId, privateKey, { ...acquire, id: "plain" })).toMatchObject({
			type: "mcp_presenter_acquired",
			id: "plain",
		});
		await answerOneForm();
		expect(frames.filter((frame) => frame.type === "mcp_form_settled")).toHaveLength(1);
		expect(frames.filter((frame) => frame.type === "mcp_form_resolved")).toHaveLength(2);
	} finally {
		for (const socket of sockets) socket.destroy();
		control.dispose();
		await new Promise<void>((resolve, reject) =>
			bootstrapServer.close((error) => (error ? reject(error) : resolve())),
		);
		await rm(root, { recursive: true, force: true });
	}
});
