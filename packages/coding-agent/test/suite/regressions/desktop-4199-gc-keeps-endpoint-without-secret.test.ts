import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointInUse } from "../../../src/modes/rpc/host-gc-evidence.ts";
import { socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { endpointScratch, sweepEndpointScratches } from "../../helpers/rpc-host-endpoint-scratch.ts";
import { deadEndpoint } from "../../helpers/rpc-host-gc-fixtures.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design test 7, lifecycle half).
// Security contract: on win32 the pipe name derives from the socket secret, so an unreadable or invalid
// secret proves nothing about whether a host still serves the pipe; gc must keep the endpoint.
describe("gc evidence for a win32 endpoint whose socket secret cannot be read", () => {
	afterEach(async () => {
		vi.unstubAllGlobals();
		await sweepEndpointScratches();
	});

	it.each([
		["missing", undefined],
		["empty", Buffer.alloc(0)],
		["short", Buffer.alloc(8, 1)],
		["long", Buffer.alloc(33, 1)],
	])("keeps an otherwise dead endpoint whose secret is %s", async (_label, content) => {
		const qa = endpointScratch("gc4199");
		const paths = await deadEndpoint(qa.legacy, qa.agentDir);
		if (content) {
			await mkdir(dirname(qa.legacy), { recursive: true });
			await writeFile(socketSecretPath(qa.legacy), content);
		}
		vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));

		expect(await endpointInUse(paths, qa.legacy)).toEqual({ inUse: "credential_unavailable" });
	});
});
