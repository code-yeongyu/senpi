// senpi#5645 (S40, brain/hand split): the hand file channel refuses everything the design rules out: a forged tool
// call, a handler block, an oversized write, a hand without the channel, a grant that is not `execute`, and a grant
// revoked while a read runs, which ships no bytes.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
	createGrantVerifier,
	createRemoteExecutor,
	DeviceFileError,
	FILE_CHANNEL_MAX_BYTES,
	type GrantVerifier,
} from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { InlineExtension } from "../../src/core/extensions/types.ts";
import { createLooplessHandScopes } from "../../src/modes/rpc/remote-executor-scope.ts";
import { BRAIN, grant, HAND, snapshotOf } from "./offline-grant-fixture.ts";
import {
	cleanupHands,
	handConfiguration,
	handDirs,
	openLink,
	remoteHost,
	runTurn,
	startHand,
	toolCall,
	toolResultTexts,
} from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

const scopeOf = (root: string) => ({ id: `scope-${crypto.randomUUID()}`, root });

async function failure(operation: Promise<unknown>): Promise<{ code: string; message: string }> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof DeviceFileError) return { code: error.code, message: error.message };
		throw error;
	}
	throw new Error("the operation succeeded");
}

function recorder(seen: string[], block?: string): InlineExtension {
	return (pi) => {
		pi.on("tool_call", (event) => {
			seen.push(event.toolName);
			return block === undefined ? undefined : { block: true, reason: block };
		});
	};
}

async function peerHand(dirs: Awaited<ReturnType<typeof handDirs>>, extensions: InlineExtension[]) {
	const link = openLink();
	const verifier: GrantVerifier = createGrantVerifier({
		self: HAND,
		workspaces: [{ root: realpathSync(dirs.cwd) }],
		canonicalize: (path) => realpathSync(path),
	});
	const executor = createRemoteExecutor({
		transport: link.hand,
		authority: { kind: "peer", peer: BRAIN, verifier },
		openScope: createLooplessHandScopes(handConfiguration(dirs), { extensionFactories: extensions }),
		fileChannel: true,
		onFault: (error) => {
			throw error;
		},
	});
	const files = remoteHost(link).deviceFiles(scopeOf(realpathSync(dirs.cwd)));
	return { verifier, executor, files };
}

describe("the hand file channel refuses what the design rules out (senpi#5645)", () => {
	it("treats an invoke named like a file operation as an unknown tool", async () => {
		const dirs = await handDirs("s40-forged");
		const link = openLink();
		startHand(link, dirs, []);

		const { agent } = await runTurn({
			calls: [toolCall("forged", "file.read", { path: join(dirs.cwd, "secret") })],
			toolHost: remoteHost(link),
			root: dirs.cwd,
		});

		expect(toolResultTexts(agent)).toEqual(["Tool file.read not found"]);
	});

	it("refuses an operation a tool_call handler blocks, with the handler's reason", async () => {
		const seen: string[] = [];
		const dirs = await handDirs("s40-block");
		const link = openLink();
		startHand(link, dirs, [recorder(seen, "memory is read-only here")]);
		const files = remoteHost(link).deviceFiles(scopeOf(dirs.cwd));

		const refused = await failure(files.write(join(dirs.cwd, "note.md"), new TextEncoder().encode("x")));

		expect(refused.code).toBe("refused_by_policy");
		expect(refused.message).toContain("memory is read-only here");
		expect(seen).toEqual(["write"]);
	});

	it("refuses an oversized write before anything reaches the hand", async () => {
		const seen: string[] = [];
		const dirs = await handDirs("s40-cap");
		const link = openLink();
		startHand(link, dirs, [recorder(seen)]);
		const files = remoteHost(link).deviceFiles(scopeOf(dirs.cwd));

		const refused = await failure(files.write(join(dirs.cwd, "big"), new Uint8Array(FILE_CHANNEL_MAX_BYTES + 1)));

		expect(refused.code).toBe("too_large");
		expect(seen).toEqual([]);
	});

	it("answers unsupported for a hand that does not announce the channel, sending it nothing", async () => {
		const seen: string[] = [];
		const dirs = await handDirs("s40-old-hand");
		const link = openLink();
		const executor = createRemoteExecutor({
			transport: link.hand,
			authority: { kind: "self" },
			openScope: createLooplessHandScopes(handConfiguration(dirs), { extensionFactories: [recorder(seen)] }),
			onFault: (error) => {
				throw error;
			},
		});
		const files = remoteHost(link).deviceFiles(scopeOf(dirs.cwd));

		const refused = await failure(files.read(join(dirs.cwd, "note.md")));

		expect(refused.code).toBe("unsupported");
		expect([seen, executor.accepted()]).toEqual([[], []]);
		await executor.close();
	});

	it("refuses every operation to a peer that holds only view", async () => {
		const dirs = await handDirs("s40-view");
		const hand = await peerHand(dirs, []);
		hand.verifier.install(snapshotOf([grant({ capability: "view" })]));

		const read = await failure(hand.files.read(join(dirs.cwd, "note.md")));
		const write = await failure(hand.files.write(join(dirs.cwd, "note.md"), new Uint8Array(1)));

		expect([read.code, write.code]).toEqual(["refused_by_grant", "refused_by_grant"]);
		await hand.executor.close();
	});

	it("ships no bytes from a read whose grant is revoked while it runs", async () => {
		const dirs = await handDirs("s40-revoke");
		let hand: Awaited<ReturnType<typeof peerHand>> | undefined;
		const revokeOnRead: InlineExtension = (pi) => {
			pi.on("tool_call", (event) => {
				if (event.toolName === "read") hand?.verifier.install(snapshotOf([], undefined, 2));
				return undefined;
			});
		};
		hand = await peerHand(dirs, [revokeOnRead]);
		hand.verifier.install(snapshotOf([grant()]));
		await hand.files.write(join(dirs.cwd, "note.md"), new TextEncoder().encode("secret"));

		const refused = await failure(hand.files.read(join(dirs.cwd, "note.md")));

		expect(refused.code).toBe("refused_by_grant");
		await hand.executor.close();
	});
});
