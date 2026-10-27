// A launched participant that claims the role named by the reservation locator in its argv with its own OS identity,
// then idles without ever answering readiness (sisyphuslabs/omo-desktop-app#4199, design 4.2a). Run with
// `node --import tsx test/fixtures/reservation-claimant.mjs <supervisor argv...>` by startHost tests that need a
// claimed, granted and then failed start.
import { openEndpointReservationStore } from "../../src/modes/rpc/endpoint-reservation-store.ts";
import { readProcessStartTime } from "../../src/utils/process-identity.ts";

const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const locator = {
	endpoint: value("--reservation-endpoint"),
	generation: value("--reservation-generation"),
	role: value("--reservation-role"),
};
const store = await openEndpointReservationStore(value("--reservation-store"));
try {
	const self = { pid: process.pid, processStartTime: (await readProcessStartTime(process.pid)) ?? null };
	store.claim(locator, store.readOffer(locator), JSON.stringify(self));
} finally {
	store.close();
}
setInterval(() => {}, 1_000);
