import { expect, it } from "vitest";
import { SessionExtensionUiRequests } from "./session-extension-ui-requests.ts";

// #4266: lifecycle hooks describe registrations and terminal transitions once.
it("emits pending and exactly one answered settle despite resolver cleanup", () => {
	const changes: unknown[] = [];
	const requests = new SessionExtensionUiRequests((event) => changes.push(event));
	const frame = {
		type: "extension_ui_request",
		id: "d",
		method: "confirm",
		title: "Confirm",
		message: "Proceed?",
	} as const;
	requests.set("d", { frame, resolve: () => requests.delete("d"), reject: () => {} });
	expect(requests.snapshot()).toEqual([frame]);
	requests.resolve({ type: "extension_ui_response", id: "d", confirmed: true });
	expect(changes).toEqual([
		{ type: "ui_request_pending", uiRequestId: "d", method: "confirm", request: frame },
		{ type: "ui_request_settled", uiRequestId: "d", disposition: "answered" },
	]);
});

it.each(["delete", "cancelAll", "close"] as const)("emits cancellation once on %s", (operation) => {
	const changes: unknown[] = [];
	const requests = new SessionExtensionUiRequests((event) => changes.push(event));
	requests.set("d", {
		frame: { type: "extension_ui_request", id: "d", method: "input", title: "Name" },
		resolve: () => requests.delete("d"),
		reject: () => {},
	});
	if (operation === "delete") requests.delete("d");
	else requests[operation]();
	requests.delete("d");
	expect(changes).toHaveLength(2);
	expect(changes[1]).toEqual({ type: "ui_request_settled", uiRequestId: "d", disposition: "cancelled" });
	expect(requests.snapshot()).toEqual([]);
});
