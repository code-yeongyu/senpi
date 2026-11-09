import { afterEach, expect, it } from "vitest";
import { RPC_METHOD_CLASSES_DIGEST } from "../../../src/modes/rpc/method-classes.ts";
import { protocolIdentity } from "../../../src/modes/rpc/protocol-identity.ts";
import { controlData } from "../../helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "../../helpers/session-control-fixture.ts";

const fixtures: EndpointFixture[] = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
});

// senpi#6158: a remote forwarder classifies each command from the engine's advertised method-class table. The TUI
// control endpoint answered get_protocol_info without one, so every command to a TUI-held session was refused as
// unclassified. Protocol contract: both endpoint kinds advertise the same table and digest.
it("advertises the rpc host's method-class table and digest on the TUI control endpoint", async () => {
	const fixture = await startEndpoint();
	fixtures.push(fixture);
	const info = (await controlData(fixture.socket, { type: "get_protocol_info" })) as Record<string, unknown>;
	expect(info.method_classes).toEqual(protocolIdentity().method_classes);
	expect(info.method_classes).toMatchObject({ digest: RPC_METHOD_CLASSES_DIGEST });
});
