import { openEndpointReservationStore } from "../../src/modes/rpc/endpoint-reservation-store.ts";

// One claimant process for desktop-4199-endpoint-reservation-race.test.ts: opens the store, reads the offer, reports
// READY, then claims as soon as the parent writes a line to stdin (the shared release barrier).
const [storePath, endpoint, generation, participant] = process.argv.slice(2);
const store = await openEndpointReservationStore(storePath);
const locator = { endpoint, generation, role: "supervisor" as const };
const nonce = store.readOffer(locator);
process.stdout.write("READY\n");
process.stdin.once("data", () => {
	let outcome: string;
	try {
		outcome = store.claim(locator, nonce, participant);
	} catch (error: unknown) {
		outcome = (error as { reason?: string }).reason ?? String(error);
	}
	process.stdout.write(`OUTCOME ${outcome}\n`);
	store.close();
	process.exit(0);
});
