import { listSlots, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";

// Synthetic Codex access tokens carrying only the claims the identity reads.
function jwt(user: string, tag: string): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const auth = { chatgpt_account_id: "ws-1", chatgpt_account_user_id: `${user}__ws-1`, chatgpt_user_id: user };
	return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": auth, jti: tag })}.sig`;
}

function oauth(user: string, tag: string) {
	return { type: "oauth" as const, access: jwt(user, tag), refresh: `refresh-${tag}`, expires: 1, accountId: "ws-1" };
}

describe("a ChatGPT re-login through the auth store replaces the invalidated account (omo#9633)", () => {
	it("leaves no older copy of the account for session affinity to pick", () => {
		const storage = AuthStorage.inMemory({ "chatgpt-subscription": oauth("user-a", "invalidated") });

		storage.set("chatgpt-subscription", oauth("user-a", "fresh"));
		storage.set("chatgpt-subscription", oauth("user-b", "other"));

		const slots = listSlots(storage.get("chatgpt-subscription") as PooledCredential);
		expect(slots.map((slot) => [slot.name, slot.refresh])).toEqual([
			["default", "refresh-fresh"],
			["login-2", "refresh-other"],
		]);
	});
});
