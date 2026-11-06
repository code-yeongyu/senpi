import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

export type Frame = Record<string, unknown>;
export type Kind = "local" | "remote" | "delegated";

export const SESSION = "synthetic-session";
export const SECRET_CAPS = ["interactive_user", "secret_input_v1"];
export const ORIGIN = { deviceId: "synthetic-device", deviceName: "Synthetic laptop" };

const cleanups: (() => Promise<void> | void)[] = [];

export function onCleanup(cleanup: () => Promise<void> | void): void {
	cleanups.push(cleanup);
}

export async function runCleanups(): Promise<void> {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export const secretPrompts = (frames: readonly Frame[]) =>
	frames.filter((frame) => frame.type === "extension_ui_request" && frame.secret === true);

/**
 * A real host core over a real writer. Each connection declares through `createHostCore.handle`, so its delegation
 * state (senpi#5632) and declared `remoteOrigin` are the ones the host itself records.
 */
export async function presenterHost() {
	const root = await mkdtemp(join(tmpdir(), "presenter-routing-"));
	const writer = new SessionEventWriter(() => {});
	const core = createHostCore(
		{
			agentDir: root,
			cwd: root,
			createRuntime: async () => {
				throw new Error("no session is opened");
			},
		},
		writer,
	);
	onCleanup(async () => {
		await core.router.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const frames = new Map<string, Frame[]>();
	const handle = (connection: string, record: Frame) =>
		writer.withConnection(connection, () => core.handle(JSON.stringify(record)));
	const received = async (id: string) => {
		await writer.flushConnection(id);
		return frames.get(id) ?? [];
	};
	const connect = async (id: string, kind: Kind, capabilities: readonly string[]) => {
		const records: Frame[] = [];
		frames.set(id, records);
		writer.registerConnection(
			id,
			{
				writeRaw: (chunk) => {
					for (const line of chunk.split("\n").filter(Boolean)) records.push(JSON.parse(line));
				},
				waitForBackpressure: async () => {},
			},
			kind === "delegated" ? { launchProof: "proven" } : {},
		);
		if (kind === "delegated")
			await handle(id, {
				type: "declare_delegation",
				id: `${id}-delegation`,
				principal: { deviceId: ORIGIN.deviceId },
				granted: ["observe", "drive", "answer"],
			});
		await handle(id, {
			type: "set_client_info",
			id: `${id}-info`,
			width: 80,
			capabilities: [...capabilities],
			...(kind === "remote" ? { remoteOrigin: ORIGIN } : {}),
		});
		const replies = (await received(id)).filter((frame) => frame.type === "response");
		expect(replies.map((reply) => [reply.id, reply.success])).toEqual([
			...(kind === "delegated" ? [[`${id}-delegation`, true]] : []),
			[`${id}-info`, true],
		]);
		records.length = 0;
		writer.attachConnectionToSession(id, SESSION);
	};
	return { writer, handle, connect, received };
}
