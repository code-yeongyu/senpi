import { describe, expect, test } from "vitest";
import { appendLoginSlot, listSlots, projectSlot, removeSlot } from "../src/auth/pool/slots.ts";

const MAINLAND = { KIMI_CODE_REGION: "mainland-cn" };
const GLOBAL = { KIMI_CODE_REGION: "global" };

function oauth(access: string, env: Record<string, string> | undefined) {
	return {
		type: "oauth" as const,
		access,
		refresh: `${access}-refresh`,
		expires: 1,
		...(env ? { env } : {}),
	};
}

describe("credential pool slots keep each account's provider env", () => {
	test("a second login in another region does not inherit the first account's region", () => {
		const pooled = appendLoginSlot(oauth("cn-access", MAINLAND), oauth("intl-access", GLOBAL));

		expect(listSlots(pooled).map((slot) => slot.env)).toEqual([MAINLAND, GLOBAL]);
		expect(projectSlot(pooled, "default")).toMatchObject({ access: "cn-access", env: MAINLAND });
		expect(projectSlot(pooled, "login-2")).toMatchObject({ access: "intl-access", env: GLOBAL });
	});

	test("a slot without its own env still reads the flat credential's env", () => {
		const pooled = appendLoginSlot(oauth("cn-access", MAINLAND), oauth("second-access", undefined));

		expect(projectSlot(pooled, "login-2")).toMatchObject({ access: "second-access", env: MAINLAND });
	});

	test("removing the projected account re-projects the survivor's env onto the flat fields", () => {
		const pooled = appendLoginSlot(oauth("cn-access", MAINLAND), oauth("intl-access", GLOBAL));

		const survivor = removeSlot(pooled, "default");

		expect(survivor).toMatchObject({ access: "intl-access", env: GLOBAL });
	});
});
