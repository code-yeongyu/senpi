import { readFileSync } from "node:fs";
import { connect, createConnection, type Socket } from "node:net";
import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import { markMcpFormPresented, type McpFormInput } from "../../../src/core/mcp-form-types.ts";
import { registerLocalMcpPresenter } from "../../../src/modes/interactive/mcp-local-presenter.ts";
import { socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { startEndpoint } from "../../helpers/session-control-fixture.ts";
import { createHarness } from "../../suite/harness.ts";
import { enroll, installation, issuer, signedCommand } from "./presenter-account-host.ts";
import { enrollmentPeer } from "./presenter-enrollment.ts";
import { mrtrTui } from "./mrtr-presentation.ts";

type Wire = Record<string, unknown>;
export const PRESENTER_ROLES = ["interactive_user", "mcp_form_presenter_v1"];

/** One terminal control connection: every record and byte it reads, and bounded waits on them. */
export class ControlClient {
	readonly records: Wire[] = [];
	bytes = "";
	private readonly waiters: Array<{ match: (record: Wire) => boolean; resolve: (record: Wire) => void }> = [];
	private next = 0;
	private readonly socket: Socket;

	private constructor(socket: Socket) {
		this.socket = socket;
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			this.bytes += text;
			buffer += text;
			for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
				const record: Wire = JSON.parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				this.records.push(record);
				for (const waiter of [...this.waiters])
					if (waiter.match(record)) {
						this.waiters.splice(this.waiters.indexOf(waiter), 1);
						waiter.resolve(record);
					}
			}
		});
	}

	static async open(path: string): Promise<ControlClient> {
		const socket = createConnection(path);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		socket.write(readFileSync(socketSecretPath(path)));
		return new ControlClient(socket);
	}

	request(command: Wire): Promise<Wire> {
		const id = `c${++this.next}`;
		const answer = this.waitFor((record) => record.id === id);
		this.socket.write(`${JSON.stringify({ ...command, id })}\n`);
		return answer;
	}

	waitFor(match: (record: Wire) => boolean): Promise<Wire> {
		const seen = this.records.find(match);
		if (seen) return Promise.resolve(seen);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("control record deadline")), 10_000);
			this.waiters.push({
				match,
				resolve: (record) => {
					clearTimeout(timer);
					resolve(record);
				},
			});
		});
	}

	close(): void {
		this.socket.destroy();
	}
}

/** A terminal form the TUI shows and never answers: it waits until another holder's answer ends its dialog. */
export function heldTerminal() {
	const shown = Promise.withResolvers<AbortSignal>();
	const select: ExtensionUIContext["select"] = (_title, _choices, options) =>
		new Promise((resolve) => {
			const signal = options?.signal;
			if (!signal) throw new Error("Missing modal lifetime");
			markMcpFormPresented(options);
			signal.addEventListener("abort", () => resolve(undefined), { once: true });
			shown.resolve(signal);
		});
	return { select, shown: shown.promise };
}

export function formInput(overrides: Partial<McpFormInput> = {}): McpFormInput {
	return {
		operationId: "operation",
		inputId: "input",
		round: 0,
		message: "terminal-form",
		server: { label: "configured-server", source: "user" },
		schema: { type: "object", properties: { name: { type: "string" } } },
		operationSignal: new AbortController().signal,
		presentationSignal: new AbortController().signal,
		deadlineMs: 10_000,
		...overrides,
	};
}

/** A terminal session with enforcement on: the TUI's own presenter, its control endpoint, and an account authority. */
export async function terminalPresenter(
	options: { readonly select?: ExtensionUIContext["select"]; readonly input?: ExtensionUIContext["input"] } = {},
) {
	const tui = mrtrTui(options.select, options.input);
	const harness = await createHarness({ persistSession: true });
	const lifetime = new AbortController();
	let admissions = 0;
	const sessionId = harness.session.sessionId;
	const local = registerLocalMcpPresenter(tui.ui, sessionId, lifetime.signal, () => admissions++);
	const fixture = await startEndpoint({
		harness,
		mcpPresenter: { local, account: issuer.authority({ account: "account-a" }) },
	});
	const sockets: Array<{ close(): void; destroy?(): void }> = [];
	const client = async (capabilities: readonly string[] = PRESENTER_ROLES, attached = true) => {
		const opened = await ControlClient.open(fixture.socket);
		sockets.push(opened);
		await opened.request({ type: "set_client_info", capabilities });
		if (attached) await opened.request({ type: "attach_session", sessionId, durableSessionId: sessionId });
		return opened;
	};
	const present = (input: Partial<McpFormInput> = {}) => {
		const presentation = local.capture();
		if (!presentation) throw new Error("Missing terminal presenter");
		return presentation.present(formInput(input));
	};
	/** A same-account desktop: discovers the control endpoint over its terminal connection, enrolls, assigns, acquires. */
	const enrollDesktop = async (desktop: ControlClient) => {
		const discovered = await desktop.request({ type: "mcp_presenter_context", sessionId, discover: true });
		const { controlEndpoint, ...context } = (discovered.context ?? {}) as Wire;
		if (typeof controlEndpoint !== "string") return { discovered };
		const socket = connect(controlEndpoint);
		sockets.push({ close: () => socket.destroy() });
		const peer = enrollmentPeer(socket);
		const device = installation();
		const { reply } = await enroll(peer, device, issuer.mint(device.publicKey));
		const principalId = reply?.principalId;
		const assigned = await signedCommand(peer, principalId, device.privateKey, {
			type: "mcp_presenter_assign",
			sessionId,
			bindingEpoch: context.bindingEpoch,
			purpose: "mcp_form",
		});
		const acquired = await signedCommand(peer, principalId, device.privateKey, {
			type: "mcp_presenter_acquire",
			id: "acquire",
			...context,
			sessionId,
			kind: "desktop",
			purpose: "mcp_form",
			features: ["elsewhere_v1"],
		});
		return { discovered, reply, assigned, acquired };
	};
	const close = async () => {
		for (const socket of sockets.splice(0)) socket.close();
		lifetime.abort();
		await fixture.endpoint.dispose();
		harness.cleanup();
		tui.lose();
	};
	return { harness, local, sessionId, client, present, enrollDesktop, close, admissions: () => admissions };
}

export function answerFrame(request: Wire, type: string, extra: Wire = {}): Wire {
	const { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision } = request;
	return { type, sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision, ...extra };
}
