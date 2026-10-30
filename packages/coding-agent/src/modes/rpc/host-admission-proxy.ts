import type { Socket } from "node:net";
import type { Duplex, Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { type HostAdmission, hostStoppingResponse } from "./host-admission.ts";
import { MAX_RPC_LINE_CHARACTERS, serializeJsonLine } from "./jsonl.ts";
import type { PublicRpcConnection } from "./rpc-public-auth.ts";

/**
 * Requests are size-bounded; each direction awaits downstream socket backpressure.
 * Opens remain concurrent with control commands. Stop refuses every pending open,
 * while other commands retain their wire order and child-owned semantics.
 */
export function proxyWithAdmission(
	client: Socket,
	internal: Duplex | undefined,
	admission: HostAdmission,
	auth?: PublicRpcConnection,
): void {
	const reply = (chunk: string | Buffer): Promise<void> =>
		write(client, auth ? auth.response(chunk.toString()) : chunk);
	const pending: unknown[] = [];
	const refused = new Set<unknown>();
	let protocols = 0;
	let refusals = Promise.resolve();
	const unsubscribe = admission.onStop(() => {
		refusals = refusePending();
		return refusals;
	});
	async function refusePending(): Promise<void> {
		const ids = pending.splice(0);
		for (const id of ids) refused.add(id);
		try {
			for (const id of ids) await reply(serializeJsonLine(hostStoppingResponse(id, "open_session", admission)));
		} catch {
			fail();
		}
	}
	client.once("close", () => {
		unsubscribe();
		internal?.destroy();
	});
	const fail = () => {
		internal?.destroy();
		client.destroy();
	};
	client.once("error", fail);
	internal?.once("error", () => {
		if (!admission.stopping) fail();
	});
	void requests().catch(() => {
		if (!admission.stopping) fail();
	});
	if (internal)
		void responses(internal).catch(() => {
			if (!admission.stopping) fail();
		});

	async function requests(): Promise<void> {
		for await (const line of lines(auth?.input ?? client, MAX_RPC_LINE_CHARACTERS)) {
			if (line === undefined) {
				await reply(
					serializeJsonLine({
						type: "response",
						command: "parse",
						success: false,
						error: `RPC input line exceeds ${MAX_RPC_LINE_CHARACTERS} characters.`,
					}),
				);
				continue;
			}
			const request = record(line);
			if (admission.stopping && request?.type === "get_protocol_info") {
				await reply(
					serializeJsonLine({
						id: request.id,
						type: "response",
						command: request.type,
						success: true,
						data: admission.protocol(),
					}),
				);
			} else if (admission.stopping && (request?.type === "open_session" || !internal)) {
				await reply(
					serializeJsonLine(hostStoppingResponse(request?.id, String(request?.type ?? "parse"), admission)),
				);
			} else if (internal) {
				// Record admission before writing: a child response can arrive immediately.
				if (request?.type === "open_session") pending.push(request.id);
				if (request?.type === "get_protocol_info") protocols++;
				await write(internal, `${line}\n`);
			}
		}
		internal?.end();
	}

	async function responses(source: Duplex): Promise<void> {
		// Keep complete records together so local refusals cannot split a streaming delta.
		// After admission, ordinary traffic stays as raw bytes with one write per chunk.
		let fragments: Buffer[] = [];
		for await (const chunk of source as AsyncIterable<Buffer>) {
			const newline = chunk.lastIndexOf(0x0a);
			if (newline === -1) {
				fragments.push(chunk);
				continue;
			}
			const complete = chunk.subarray(0, newline + 1);
			if (!auth && pending.length === 0 && protocols === 0 && refused.size === 0) {
				// Queue the entire record batch synchronously, without copying split buffers.
				client.cork();
				let written: Promise<void>;
				try {
					for (const fragment of fragments) client.write(fragment);
					written = write(client, complete);
				} finally {
					client.uncork();
				}
				await written;
			} else {
				const batch = fragments.length > 0 ? Buffer.concat([...fragments, complete]) : complete;
				await reply(filterReplies(batch));
			}
			fragments = newline + 1 < chunk.length ? [chunk.subarray(newline + 1)] : [];
		}
		if (fragments.length > 0) await reply(filterReplies(Buffer.concat(fragments)));
		await refusals;
		client.end(() => client.destroy());
	}

	function filterReplies(batch: Buffer): Buffer {
		if (pending.length === 0 && protocols === 0 && refused.size === 0) return batch;
		const output: Buffer[] = [];
		let changed = false;
		for (let start = 0; start < batch.length; ) {
			const newline = batch.indexOf(0x0a, start);
			const end = newline === -1 ? batch.length : newline + 1;
			const line = batch.subarray(start, end);
			start = end;
			// Only lifecycle responses need decoding; histories and deltas remain byte slices.
			const response =
				line.includes('"open_session"') || line.includes('"get_protocol_info"')
					? record(line.toString("utf8"))
					: undefined;
			if (response?.type === "response" && response.command === "open_session") {
				if (refused.has(response.id)) {
					changed = true;
					continue;
				}
				const index = pending.indexOf(response.id);
				if (index !== -1) pending.splice(index, 1);
			}
			if (response?.type === "response" && response.command === "get_protocol_info") {
				protocols = Math.max(0, protocols - 1);
				if (response.success === true) {
					if (isRecord(response.data)) admission.observe(response.data);
					output.push(Buffer.from(serializeJsonLine({ ...response, data: admission.protocol() })));
					changed = true;
					continue;
				}
			}
			output.push(line);
		}
		return changed ? Buffer.concat(output) : batch;
	}
}

async function write(socket: Duplex, line: string | Buffer): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		socket.write(line, (error) => (error ? reject(error) : resolve()));
	});
}

/** Strict LF and incremental UTF-8; an oversized input is discarded through its next LF. */
async function* lines(socket: Readable, limit: number): AsyncGenerator<string | undefined> {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let discarding = false;
	for await (const chunk of socket) {
		const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
		let offset = 0;
		while (offset < text.length) {
			const newline = text.indexOf("\n", offset);
			const end = newline === -1 ? text.length : newline;
			if (!discarding) {
				if (buffer.length + end - offset > limit) {
					buffer = "";
					discarding = true;
					yield undefined;
				} else buffer += text.slice(offset, end);
			}
			if (newline === -1) break;
			if (!discarding) yield buffer;
			buffer = "";
			discarding = false;
			offset = newline + 1;
		}
	}
	buffer += decoder.end();
	if (!discarding && buffer.length > 0) yield buffer;
}

function record(line: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
