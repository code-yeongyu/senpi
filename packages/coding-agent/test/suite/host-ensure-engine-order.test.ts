// senpi#7040, senpi#7058: an ensure that may upgrade says on stderr when it cannot order its own engine against the
// running host's, and only when it then keeps that host. `engine order uncomparable` is the token docs/rpc.md names.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type EngineBuildIdentity,
	engineBuildIdentity,
	engineBuildIdentityFrom,
} from "../../src/core/engine-build-identity.ts";
import {
	HANDOFF_ADMISSION_CAPABILITY,
	HOST_PROTOCOL_VERSION,
	type HostProtocolInfo,
	REQUIRED_HOST_CAPABILITIES,
} from "../../src/modes/rpc/host-decision.ts";
import { decideEnsureAction } from "../../src/modes/rpc/host-ensure-client.ts";

// A compiled omo through 5.1.78 stated its omo version as its engine: an ordinal outside senpi CalVer.
const OMO_VERSION = engineBuildIdentityFrom({ version: "5.1.78" });
const OLDER_CALVER = engineBuildIdentityFrom({ version: "2000.1.1" });

function runningHost(engine: EngineBuildIdentity, overrides: Partial<HostProtocolInfo> = {}): HostProtocolInfo {
	return {
		protocolVersion: HOST_PROTOCOL_VERSION,
		serverVersion: engine.text,
		capabilities: [...REQUIRED_HOST_CAPABILITIES, HANDOFF_ADMISSION_CAPABILITY],
		engineVersion: engine.text,
		engineOrdinal: engine.ordinal,
		...overrides,
	};
}

function ensureWithUpgrade(host: HostProtocolInfo): { readonly action: string; readonly lines: readonly string[] } {
	const written: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	});
	const decision = decideEnsureAction({ socket: "unused", upgrade: "if-engine-differs" }, false, host);
	return { action: decision.action, lines: written.join("").split("\n").filter(Boolean) };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("an ensure that may upgrade, facing a host whose engine it cannot order", () => {
	it("keeps a host on an omo-version ordinal and says so in one line naming both engines", () => {
		const own = engineBuildIdentity();

		const { action, lines } = ensureWithUpgrade(runningHost(OMO_VERSION));

		expect(action).toBe("reuse");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("engine order uncomparable");
		expect(lines[0]).toContain(`${own.text} [${own.ordinal.join(",")}]`);
		expect(lines[0]).toContain("5.1.78 [5,1,78,0,0]");
	});

	it("writes nothing when it refuses that host: no running host is kept", () => {
		const { action, lines } = ensureWithUpgrade(
			runningHost(OMO_VERSION, { protocolVersion: HOST_PROTOCOL_VERSION + 1 }),
		);

		expect(action).toBe("refuse");
		expect(lines).toEqual([]);
	});

	it("writes nothing for a host on a CalVer ordinal, which it can order", () => {
		const { action, lines } = ensureWithUpgrade(runningHost(OLDER_CALVER));

		expect(action).toBe("reuse");
		expect(lines).toEqual([]);
	});
});
