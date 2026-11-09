import { readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { endpointBindsDirectly, signalEndpointReady } from "./helpers/rpc-endpoint-ready.ts";

const fixturesDir = join(import.meta.dirname, "fixtures");
const rpcFixtures = readdirSync(fixturesDir)
	.filter((name) => /^rpc-.*\.ts$/.test(name))
	.sort();

// senpi#5912: a fixture that signals readiness only from a mocked `fs.promises.link` hangs on an endpoint that is
// bound directly and never linked (a Windows pipe, a Linux abstract socket). The rule lives in one helper.
describe("rpc fixtures signal endpoint readiness through the shared helper", () => {
	it("no rpc fixture mocks fs.promises.link itself", () => {
		const ownLinkMocks = rpcFixtures.filter((name) =>
			/mock\.method\(\s*[\w.]+\s*,\s*["'`]link["'`]/.test(readFileSync(join(fixturesDir, name), "utf8")),
		);
		expect(ownLinkMocks).toEqual([]);
	});

	it("every lifecycle fixture that waits for the public endpoint uses the helper", () => {
		const users = rpcFixtures.filter((name) =>
			readFileSync(join(fixturesDir, name), "utf8").includes("../helpers/rpc-endpoint-ready.ts"),
		);
		expect(users).toEqual(
			expect.arrayContaining(["rpc-lifecycle-clock.ts", "rpc-owner-review-clock.ts", "rpc-stopping-supervisor.ts"]),
		);
	});

	it("treats a Windows pipe and an abstract socket as bound directly, and a filesystem path as linked", () => {
		expect(endpointBindsDirectly("\\\\.\\pipe\\senpi", "win32")).toBe(true);
		expect(endpointBindsDirectly("\0senpi-abstract", "linux")).toBe(true);
		expect(endpointBindsDirectly("/run/senpi/host.sock", "linux")).toBe(false);
		expect(endpointBindsDirectly("/run/senpi/host.sock", "darwin")).toBe(false);
	});

	it("signals a directly bound endpoint at listening", () => {
		let signals = 0;
		const onServer = signalEndpointReady("\0senpi-abstract", () => signals++);
		const server = new net.Server();
		onServer(server);
		expect(signals).toBe(0);
		server.emit("listening");
		expect(signals).toBe(1);
	});
});
