/**
 * senpi#6484: a replacement swaps the session behind a handle, then waits for the replaced session's extensions to be
 * told which of them the new session dropped (`session_extensions_removed`, any length) before it answers. In that
 * window the host's record of the handle must already name the new session, and a release or an unload sent then must
 * name what it acted on, or act on nothing.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory, LoadExtensionsResult } from "../../src/core/extensions/types.ts";
import { outgoingStateDir } from "../../src/core/session-move/extension-state.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import type { RouterContext } from "../../src/modes/rpc/session-router-context.ts";
import { gatewayFixture } from "./rpc-release-gateway-fixture.ts";
import { heldTurn, nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";
import { bindingSettled, sealedTranscripts, storedRecord } from "./rpc-replacement-follow-support.ts";

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
	}, 120_000);

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
	}, 120_000);

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
	}, 120_000);

	it.each(
		[false, true].flatMap((interrupt) =>
			(["still binding", "quiet"] as const).map((successor) => ({ interrupt, successor })),
		),
	)(
		"a move release without expectSessionId that a replacement crosses is refused, not sealed on the successor (interrupt: $interrupt, successor $successor)",
		async ({ interrupt, successor }) => {
			let exportEntered!: () => void;
			const exporting = new Promise<void>((resolve) => {
				exportEntered = resolve;
			});
			let letExportGo!: () => void;
			const exportHeld = new Promise<void>((resolve) => {
				letExportGo = resolve;
			});
			let newSessionStarted!: () => void;
			const successorStarted = new Promise<void>((resolve) => {
				newSessionStarted = resolve;
			});
			const gateway = gatewayFixture();
			const extension: ExtensionFactory = (pi) => {
				gateway.extension(pi);
				pi.on("session_move_export", async (event) => {
					mkdirSync(join(event.dir, "staged-by-the-first-session"), { recursive: true });
					exportEntered();
					await exportHeld;
				});
				pi.on("session_start", (event) => {
					if (event.reason === "new") newSessionStarted();
				});
			};
			await using host = await startReleaseHost(extension);
			host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
			const s1 = await host.open("s1");
			const folder = dirname(s1.sessionPath);
			if (interrupt) {
				const started = nextEvent(s1.session, "agent_start");
				await host.send(send({ type: "prompt", id: "work", sessionId: s1.sessionId, message: "long work" }));
				await started;
				await host.send(
					send({ type: "follow_up", id: "queued", sessionId: s1.sessionId, message: "after the work" }),
				);
			}

			const releasing = host.send(
				send({
					type: "release_session",
					id: "release",
					sessionId: s1.sessionId,
					reason: "move",
					moveId: "move-6484",
					target: "device-b",
					...(interrupt ? { interrupt: true } : {}),
				}),
			);
			await exporting;
			const replaced = host.send(send({ type: "new_session", id: "replace", sessionId: s1.sessionId }), "replacer");
			await successorStarted;
			// Still binding, a release of the successor would be refused as busy; once it is quiet, it would be sealed.
			if (successor === "quiet") await bindingSettled(host, s1.sessionId);
			letExportGo();
			const answer = await releasing;

			expect(answer).toMatchObject({ success: false, errorCode: "session_mismatch" });
			expect((answer.errorData as Wire).expected).toBeUndefined();
			if (interrupt)
				expect(answer.errorData).toMatchObject({
					interrupted: true,
					dropped: { user_messages: ["after the work"] },
					taken_from: s1.session.sessionId,
				});
			else expect((answer.errorData as Wire).taken_from).toBeUndefined();
			const state = await host.send(send({ type: "get_state", id: "state", sessionId: s1.sessionId }));
			expect(JSON.stringify(answer)).not.toContain(String((state.data as Wire).sessionId));
			expect(sealedTranscripts(folder)).toEqual([]);
			const stagedRoot = outgoingStateDir(s1.sessionPath, "move-6484" as MoveId);
			expect(existsSync(stagedRoot) ? readdirSync(stagedRoot) : []).toEqual([]);
			expect(await replaced).toMatchObject({ success: true });
		},
		120_000,
	);

	it("a move release that crosses a switch back to the same session is refused and releases nothing", async () => {
		let exportEntered!: () => void;
		const exporting = new Promise<void>((resolve) => {
			exportEntered = resolve;
		});
		let letExportGo!: () => void;
		const exportHeld = new Promise<void>((resolve) => {
			letExportGo = resolve;
		});
		const gateway = gatewayFixture();
		const extension: ExtensionFactory = (pi) => {
			gateway.extension(pi);
			pi.on("session_move_export", async () => {
				exportEntered();
				await exportHeld;
			});
		};
		await using host = await startReleaseHost(extension);
		const s1 = await host.open("s1");
		const folder = dirname(s1.sessionPath);

		const releasing = host.send(
			send({
				type: "release_session",
				id: "release",
				sessionId: s1.sessionId,
				reason: "move",
				moveId: "move-6484",
				target: "device-b",
			}),
		);
		await exporting;
		// The same durable session, rebuilt: a new session object behind the route, no other session.
		const switched = await host.send(
			send({ type: "switch_session", id: "switch", sessionId: s1.sessionId, sessionPath: s1.sessionPath }),
			"replacer",
		);
		expect(switched).toMatchObject({ success: true });
		await bindingSettled(host, s1.sessionId);
		letExportGo();
		const answer = await releasing;

		expect(answer).toMatchObject({ success: false, errorCode: "session_mismatch" });
		expect((answer.errorData as Wire).expected).toBeUndefined();
		expect(sealedTranscripts(folder)).toEqual([]);
		const state = await host.send(send({ type: "get_state", id: "state", sessionId: s1.sessionId }));
		expect(state.data).toMatchObject({ sessionId: s1.session.sessionId });
	}, 120_000);

	it.each([{ crossed: true }, { crossed: false }])(
		"an interrupting release refused after another client attached says which session its taken input came from (crossed by a replacement: $crossed)",
		async ({ crossed }) => {
			let exportEntered!: () => void;
			const exporting = new Promise<void>((resolve) => {
				exportEntered = resolve;
			});
			let letExportGo!: () => void;
			const exportHeld = new Promise<void>((resolve) => {
				letExportGo = resolve;
			});
			let newSessionStarted!: () => void;
			const successorStarted = new Promise<void>((resolve) => {
				newSessionStarted = resolve;
			});
			const gateway = gatewayFixture();
			const extension: ExtensionFactory = (pi) => {
				gateway.extension(pi);
				pi.on("session_move_export", async () => {
					exportEntered();
					await exportHeld;
				});
				pi.on("session_start", (event) => {
					if (event.reason === "new") newSessionStarted();
				});
			};
			await using host = await startReleaseHost(extension);
			host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
			const s1 = await host.open("s1");
			const folder = dirname(s1.sessionPath);
			const takenFrom = s1.session.sessionId;
			const started = nextEvent(s1.session, "agent_start");
			await host.send(send({ type: "prompt", id: "work", sessionId: s1.sessionId, message: "long work" }));
			await started;
			await host.send(send({ type: "follow_up", id: "queued", sessionId: s1.sessionId, message: "after the work" }));

			const releasing = host.send(
				send({
					type: "release_session",
					id: "release",
					sessionId: s1.sessionId,
					reason: "move",
					moveId: "move-6484",
					target: "device-b",
					interrupt: true,
				}),
			);
			await exporting;
			expect(await host.attach(s1.sessionPath, "second-client")).toMatchObject({ success: true });
			if (crossed) {
				const replaced = host.send(
					send({ type: "new_session", id: "replace", sessionId: s1.sessionId }),
					"replacer",
				);
				await successorStarted;
				await bindingSettled(host, s1.sessionId);
				expect(await replaced).toMatchObject({ success: true });
			}
			letExportGo();
			const answer = await releasing;

			expect(answer).toMatchObject({
				success: false,
				errorCode: crossed ? "session_mismatch" : "attached",
				errorData: { interrupted: true, dropped: { user_messages: ["after the work"] }, taken_from: takenFrom },
			});
			expect(sealedTranscripts(folder)).toEqual([]);
		},
		120_000,
	);
});
