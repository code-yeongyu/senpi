import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import type { PresenterAccountAuthority } from "../../src/modes/rpc/mcp-presenter-account.ts";
import { McpPresenterControl } from "../../src/modes/rpc/mcp-presenter-control.ts";
import {
	type McpPresenterControlStart,
	startMcpPresenterControl,
} from "../../src/modes/rpc/mcp-presenter-control-start.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

const account: PresenterAccountAuthority = {
	hostAccount: () => "account",
	verify: async () => {
		throw new Error("discovery never verifies an attestation");
	},
	onAccountChange: () => () => {},
};

const started: McpPresenterControlStart[] = [];
afterEach(async () => {
	for (const { control, dir } of started.splice(0)) {
		control.dispose();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

function enforcedWriter() {
	const lines: string[] = [];
	const writer = new SessionEventWriter(() => {});
	const authority = writer.enableMcpPresenters();
	writer.registerConnection("human", {
		writeRaw: (line) => lines.push(line),
		waitForBackpressure: async () => {},
	});
	writer.bindMcpForms("session", "durable", {}, () => {});
	writer.attachConnectionToSession("human", "session");
	const sender = writer.getMcpPresenterConnection("human");
	if (!sender) throw new Error("Missing presenter connection");
	const context = (extra: Record<string, unknown> = {}, peer = "human"): string => {
		const before = lines.length;
		writer.withConnection(peer, () =>
			writer.handleMcpForm({ type: "mcp_presenter_context", id: "context", sessionId: "session", ...extra }),
		);
		const reply = lines.slice(before).find((line) => JSON.parse(line).id === "context");
		if (reply === undefined) throw new Error("No mcp_presenter_context reply");
		return reply;
	};
	const today = () =>
		`${JSON.stringify({
			type: "mcp_form_reply",
			id: "context",
			ok: true,
			context: authority.connectionContext(sender, "session"),
		})}\n`;
	const late = (peer: string) => {
		writer.registerConnection(peer, { writeRaw: (line) => lines.push(line), waitForBackpressure: async () => {} });
		writer.bindMcpForms("session", "durable", {}, () => {});
		writer.attachConnectionToSession(peer, "session");
	};
	return { writer, context, today, late };
}

async function start(
	writer: SessionEventWriter,
	options: Parameters<typeof startMcpPresenterControl>[1],
): Promise<McpPresenterControlStart | undefined> {
	const result = await startMcpPresenterControl(writer, options);
	if (result) started.push(result);
	return result;
}

it("an enforced host with an injected account authority and no fd 4 answers discover with its control endpoint", async () => {
	const { writer, context } = enforcedWriter();
	const presenter = await start(writer, { enforcement: true, account });
	if (!presenter) throw new Error("No control endpoint on an enforced host with an account authority");
	const reply = JSON.parse(context({ discover: true }));
	expect(reply).toMatchObject({ ok: true, context: { controlEndpoint: presenter.control.path } });
	const socket = connect(reply.context.controlEndpoint);
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
	} finally {
		socket.destroy();
	}
});

it.each([
	["absent", {}],
	["false", { discover: false }],
	["a string", { discover: "true" }],
])("without discover: true (%s) the context reply is byte-identical", async (_name, extra) => {
	const { writer, context, today } = enforcedWriter();
	expect(await start(writer, { enforcement: true, account })).toBeDefined();
	expect(context(extra)).toBe(today());
});

it("with no account authority an fd-4 host's discover reply carries no controlEndpoint key", async () => {
	const { writer, context, today } = enforcedWriter();
	expect(await start(writer, { enforcement: true, bootstrap: new PassThrough() })).toBeDefined();
	expect(context({ discover: true })).toBe(today());
});

it("a control whose listen fails is never advertised", async () => {
	const { writer, context } = enforcedWriter();
	const dir = await mkdtemp(join(tmpdir(), "presenter-unlistenable-"));
	const control = new McpPresenterControl(writer, join(dir, "missing", "control.sock"), account);
	try {
		await expect(control.listen()).rejects.toThrow();
		expect(JSON.parse(context({ discover: true }))).toEqual({
			type: "mcp_form_reply",
			id: "context",
			ok: true,
			context: expect.not.objectContaining({ controlEndpoint: expect.anything() }),
		});
	} finally {
		control.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});

it("a disposed control is not advertised to a session bound after it", async () => {
	const { writer, context, late } = enforcedWriter();
	const presenter = await start(writer, { enforcement: true, account });
	if (!presenter) throw new Error("No control endpoint");
	presenter.control.dispose();
	late("late");
	const reply = JSON.parse(context({ discover: true }, "late"));
	expect(reply.ok).toBe(true);
	expect(reply.context).not.toHaveProperty("controlEndpoint");
});

it("an authority does not create a control endpoint without enforcement, and the bootstrap is closed", async () => {
	const bootstrap = new PassThrough();
	expect(await start(new SessionEventWriter(() => {}), { account, bootstrap })).toBeUndefined();
	expect(bootstrap.destroyed).toBe(true);
});
