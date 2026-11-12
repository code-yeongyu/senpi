/**
 * senpi#6484: a replacement swaps the session behind a handle, then waits for the replaced session's extensions to be
 * told which of them the new session dropped (`session_extensions_removed`, any length) before it answers. In that
 * window the host's record of the handle must already name the new session, and a release or an unload sent then must
 * name what it acted on, or act on nothing.
 */
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadExtensionsResult } from "../../src/core/extensions/types.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import type { RouterContext } from "../../src/modes/rpc/session-router-context.ts";
import { gatewayFixture } from "./rpc-release-gateway-fixture.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";
import { sealedTranscripts, storedRecord } from "./rpc-replacement-follow-support.ts";

type Wire = Record<string, unknown>;
const send = (command: Wire): RpcCommand & { id: string } => command as unknown as RpcCommand & { id: string };
const HELD = "<inline:held-removal>";

describe("a release or an unload while a replacement is still telling extensions of a removal (senpi#6484)", () => {
	it("the record names the new session, and each answer names what it acted on or nothing was acted on", async () => {
		let dropHeld = false;
		let entered!: () => void;
		const inHandler = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let letGo!: () => void;
		const held = new Promise<void>((resolve) => {
			letGo = resolve;
		});
		await using host = await startReleaseHost(gatewayFixture().extension, {
			extensions: [
				{
					name: "held-removal",
					factory: (pi) => {
						pi.on("session_extensions_removed", async () => {
							entered();
							await held;
						});
					},
				},
			],
			extensionsOverride: (base: LoadExtensionsResult) =>
				dropHeld ? { ...base, extensions: base.extensions.filter((extension) => extension.path !== HELD) } : base,
		});
		const s1 = await host.open("s1");
		const folder = dirname(s1.sessionPath);
		dropHeld = true;
		const replaced = host.send(send({ type: "new_session", id: "replace", sessionId: s1.sessionId }), "replacer");
		await inHandler;
		const running = (Reflect.get(host.router, "context") as RouterContext).registry.peek(s1.sessionId)?.runtime
			?.session;
		if (running === undefined) throw new Error("no session behind the handle while the handler is held");
		expect(running.sessionId).not.toBe(s1.session.sessionId);

		expect(storedRecord(host, s1.sessionId)).toEqual({
			sessionPath: running.sessionFile,
			durableSessionId: running.sessionId,
		});
		const release = await host.send(
			send({ type: "release_session", id: "release", sessionId: s1.sessionId, reason: "takeover" }),
			"other",
		);
		const unload = await host.send(send({ type: "unload_session", id: "unload", sessionId: s1.sessionId }), "other");

		if (release.success === true) {
			expect(release.data).toMatchObject({ session_path: running.sessionFile, session_id: running.sessionId });
			expect(sealedTranscripts(folder)).toEqual([running.sessionFile]);
		} else {
			expect(sealedTranscripts(folder)).toEqual([]);
		}
		if ((unload.data as Wire | undefined)?.outcome === "unloaded") {
			expect(unload.data).toMatchObject({ sessionPath: running.sessionFile });
		}
		letGo();
		expect(await replaced).toMatchObject({ success: true });
	});

	it("while the new session is still being built after the old one was disposed, a release and an unload act on nothing", async () => {
		let holdBuild = false;
		let entered!: () => void;
		const building = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let letGo!: () => void;
		const held = new Promise<void>((resolve) => {
			letGo = resolve;
		});
		await using host = await startReleaseHost(gatewayFixture().extension, {
			beforeBuild: async () => {
				if (!holdBuild) return;
				entered();
				await held;
			},
		});
		const s1 = await host.open("s1");
		const folder = dirname(s1.sessionPath);
		holdBuild = true;
		const replaced = host.send(send({ type: "new_session", id: "replace", sessionId: s1.sessionId }), "replacer");
		await building;

		const release = await host.send(
			send({ type: "release_session", id: "release", sessionId: s1.sessionId, reason: "takeover" }),
			"other",
		);
		const unload = await host.send(send({ type: "unload_session", id: "unload", sessionId: s1.sessionId }), "other");

		expect(release.success).not.toBe(true);
		expect((unload.data as Wire | undefined)?.outcome).not.toBe("unloaded");
		expect(sealedTranscripts(folder)).toEqual([]);
		holdBuild = false;
		letGo();
		expect(await replaced).toMatchObject({ success: true });
	});

	it("a replacing command sent in the same turn as a release never runs on the released session", async () => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		const s1 = await host.open("s1");
		const folder = dirname(s1.sessionPath);

		// Neither is awaited before the other is sent: the release claims the close before its first await.
		const releasing = host.send(
			send({ type: "release_session", id: "release", sessionId: s1.sessionId, reason: "takeover" }),
		);
		const replacing = host.send(send({ type: "new_session", id: "replace", sessionId: s1.sessionId }), "replacer");
		const [release, replace] = await Promise.all([releasing, replacing]);

		expect(release).toMatchObject({
			success: true,
			data: { released: true, session_path: s1.sessionPath, session_id: s1.session.sessionId },
		});
		expect(sealedTranscripts(folder)).toEqual([s1.sessionPath]);
		expect(replace.success).toBe(false);
		expect(readdirSync(folder).filter((name) => name.endsWith(".jsonl"))).toEqual(["s1.jsonl"]);
	});
});
