// senpi#7044: the admission behind a handoff is single-use, bound to the connection it was granted on, and short-lived.
// The wire and the drain it starts are proven against a real host in
// test/suite/regressions/7044-incumbent-handoff-veto.test.ts. A real host cannot be made to wait out an admission's
// lifetime, so what ends an admission - its use, its connection, its age - is pinned here on the grant itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineBuildIdentityFrom } from "../../src/core/engine-build-identity.ts";
import {
	ADMIT_HANDOFF_COMMAND,
	DRAIN_FOR_HANDOFF_COMMAND,
	HANDOFF_ADMISSION_TTL_MS,
	HostHandoffAdmissions,
} from "../../src/modes/rpc/host-handoff-admission.ts";

const ENGINE = engineBuildIdentityFrom({ version: "2026.11.19" });

function host() {
	let drains = 0;
	const answers: object[] = [];
	const admissions = new HostHandoffAdmissions({
		engine: () => ENGINE,
		drain: () => {
			drains += 1;
		},
		log: () => {},
	});
	const admit = (connection: string): string => {
		const answer = admissions.admit(
			{ type: ADMIT_HANDOFF_COMMAND, successor_engine: { text: ENGINE.text, ordinal: ENGINE.ordinal } },
			connection,
		);
		const id: unknown = Reflect.get(Object(answer.data), "admission_id");
		if (typeof id !== "string") throw new Error(`the host admitted nothing: ${JSON.stringify(answer)}`);
		return id;
	};
	const present = async (connection: string, admissionId: string): Promise<object | undefined> => {
		await admissions.drain(
			{ type: DRAIN_FOR_HANDOFF_COMMAND, admission_id: admissionId },
			connection,
			async (answer) => {
				answers.push(answer);
			},
		);
		return answers.at(-1);
	};
	return { admissions, admit, present, drains: () => drains };
}

const REFUSED = { data: { refused: "unknown_admission" } };

afterEach(() => vi.useRealTimers());

describe("a handoff admission", () => {
	it("is used up by the drain it backs", async () => {
		const { admit, present, drains } = host();
		const admission = admit("requester");

		expect(await present("requester", admission)).toMatchObject({ data: { draining: true } });
		expect(await present("requester", admission)).toMatchObject(REFUSED);

		expect(drains()).toBe(1);
	});

	it("ends with the connection it was granted on", async () => {
		const { admissions, admit, present, drains } = host();
		const admission = admit("requester");

		admissions.release("requester");

		expect(await present("requester", admission)).toMatchObject(REFUSED);
		expect(drains()).toBe(0);
	});

	it("is replaced by a later admission on the same connection", async () => {
		const { admit, present, drains } = host();
		const earlier = admit("requester");
		const later = admit("requester");

		expect(await present("requester", earlier)).toMatchObject(REFUSED);
		expect(await present("requester", later)).toMatchObject({ data: { draining: true } });
		expect(drains()).toBe(1);
	});

	it("no longer drains once its lifetime has passed", async () => {
		vi.useFakeTimers();
		const { admit, present, drains } = host();
		const admission = admit("requester");

		vi.advanceTimersByTime(HANDOFF_ADMISSION_TTL_MS);

		expect(await present("requester", admission)).toMatchObject(REFUSED);
		expect(drains()).toBe(0);
	});
});
