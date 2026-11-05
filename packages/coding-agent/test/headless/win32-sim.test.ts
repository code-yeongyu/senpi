import { isWin32PipeEndpoint, toWin32Path, win32NamesEqual } from "@earendil-works/pi-agent-core/testing/win32-sim";
import { describe, expect, it } from "vitest";
import { headlessEndpoint, headlessSocketPath } from "../../src/modes/headless/headless-host.ts";
import { resolveSocketPath } from "../../src/modes/rpc/host-socket-bind.ts";
import { resolveSocketTransportAddress } from "../../src/modes/rpc/socket-transport.ts";
import { startHostRig } from "./headless-host-support.ts";

describe("headless engine under the win32 profile", () => {
	const agentDir = toWin32Path("Users\\dev\\.senpi");

	it("listens on a named pipe derived from a drive-qualified socket path, case-insensitively", () => {
		const socketPath = headlessSocketPath(agentDir, "win32");
		expect(socketPath).toBe(`${agentDir}\\rpc\\headless.sock`);
		const endpoint = headlessEndpoint(agentDir, "win32");
		expect(isWin32PipeEndpoint(endpoint)).toBe(true);
		const differentlyCased = toWin32Path("USERS\\Dev\\.SENPI");
		expect(win32NamesEqual(differentlyCased, agentDir)).toBe(true);
		expect(headlessEndpoint(differentlyCased, "win32")).toBe(endpoint);
	});

	it("does not share the default host's pipe", () => {
		const defaultHost = resolveSocketTransportAddress(
			resolveSocketPath("unix://", agentDir).replaceAll("/", "\\"),
			"win32",
		);
		expect(headlessEndpoint(agentDir, "win32")).not.toBe(defaultHost);
	});

	it("lets two sessions attach, detach and re-attach without either ending", async () => {
		const rig = await startHostRig("headless");
		try {
			rig.connect("first");
			rig.connect("second");
			rig.connect("observer");
			const firstFile = await rig.newSessionFile();
			const secondFile = await rig.newSessionFile();
			const first = await rig.openSession("first", firstFile);
			const second = await rig.openSession("second", secondFile);
			await rig.detach("first");
			await rig.detach("second");
			const rows = await rig.listSessions("observer");
			expect(rows.map((row) => [row.sessionId, row.status, row.attachments]).sort()).toEqual(
				[
					[first, "open", 0],
					[second, "open", 0],
				].sort(),
			);
			rig.connect("first");
			rig.connect("second");
			expect(await rig.openSession("first", firstFile)).toBe(first);
			expect(await rig.openSession("second", secondFile)).toBe(second);
		} finally {
			await rig.dispose();
		}
	}, 30_000);
});
