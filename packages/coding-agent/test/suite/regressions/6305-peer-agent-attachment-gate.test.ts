import { afterEach, describe, expect, it } from "vitest";
import { createAuthority, maskOfRoles } from "../../../src/modes/rpc/connection-authority.ts";
import { ConnectionRoles } from "../../../src/modes/rpc/connection-roles.ts";
import { attachmentGate } from "../../../src/modes/rpc/session-attachment-gate.ts";

const CONNECTION = "conn-peer";

function host(roles: readonly string[]) {
	const connectionRoles = new ConnectionRoles();
	const descriptor = {
		principal: { deviceId: "dev-1" },
		mode: "host" as const,
		incarnation: 1,
		authority: createAuthority(1, maskOfRoles(roles)),
	};
	connectionRoles.useDelegations((connection) =>
		connection === CONNECTION ? { descriptor, closed: false } : undefined,
	);
	return {
		connectionRoles,
		sessionsByConnection: new Map<string, Set<string>>(),
		writer: { currentConnection: () => CONNECTION, recoveryPages: undefined },
	};
}

const admit = { id: "a1", type: "admit_external_message", sessionId: "s-1" };

describe("senpi#6305 the attachment gate and a forwarder-granted peer_agent connection", () => {
	const previous = process.env.SENPI_RPC_REQUIRE_ATTACH;
	afterEach(() => {
		if (previous === undefined) delete process.env.SENPI_RPC_REQUIRE_ATTACH;
		else process.env.SENPI_RPC_REQUIRE_ATTACH = previous;
	});

	it("admits an unattached peer_agent connection's admit_external_message even when attachment is required", () => {
		process.env.SENPI_RPC_REQUIRE_ATTACH = "1";
		expect(attachmentGate(host(["peer_agent"]) as never, admit as never)).toBeUndefined();
	});

	it("still refuses an unattached delegated connection without peer_agent", () => {
		process.env.SENPI_RPC_REQUIRE_ATTACH = "1";
		expect(attachmentGate(host([]) as never, admit as never)).toMatchObject({ success: false });
	});

	it("still refuses any other command from the peer_agent connection", () => {
		process.env.SENPI_RPC_REQUIRE_ATTACH = "1";
		const prompt = { id: "p1", type: "prompt", sessionId: "s-1", message: "x" };
		expect(attachmentGate(host(["peer_agent"]) as never, prompt as never)).toMatchObject({ success: false });
	});
});
