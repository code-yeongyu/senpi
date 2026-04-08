import { describe, expect, it } from "vitest";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.js";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.js";
import {
	CorrectedError,
	DeniedError,
	RejectedError,
	type Request,
	type Ruleset,
} from "../../src/core/extensions/builtin/permission-system/types.js";

function createRequest(overrides: Partial<Request> = {}): Request {
	return {
		id: overrides.id ?? "request-1",
		sessionID: overrides.sessionID ?? "session-1",
		permission: overrides.permission ?? "bash",
		patterns: overrides.patterns ?? ["git commit"],
		always: overrides.always ?? ["git *"],
		metadata: overrides.metadata ?? { command: "git commit -m test" },
		tool: overrides.tool,
	};
}

function createService(staticRuleset: Ruleset = [], approved: Ruleset = []) {
	const emitter = createLocalEventEmitter();
	const askedEvents: Request[] = [];
	const repliedEvents: Array<{ requestID: string; sessionID: string; reply: "once" | "always" | "reject" | "allow" }> =
		[];

	emitter.onAsked((request) => {
		askedEvents.push(request);
	});
	emitter.onReplied((event) => {
		repliedEvents.push(event);
	});

	return {
		emitter,
		askedEvents,
		repliedEvents,
		service: new PermissionService(staticRuleset, approved, emitter),
	};
}

describe("PermissionService", () => {
	describe("ask", () => {
		it("returns immediately when static rules allow every pattern", async () => {
			// given
			const { service, askedEvents, repliedEvents } = createService([
				{ permission: "bash", pattern: "*", action: "allow" },
			]);

			// when
			await expect(service.ask(createRequest())).resolves.toBeUndefined();

			// then
			expect(service.list()).toEqual([]);
			expect(askedEvents).toEqual([]);
			expect(repliedEvents).toEqual([{ requestID: "request-1", sessionID: "session-1", reply: "allow" }]);
		});

		it("returns immediately when approved rules allow every pattern", async () => {
			// given
			const { service, repliedEvents } = createService(
				[],
				[{ permission: "bash", pattern: "git *", action: "allow" }],
			);

			// when
			await expect(service.ask(createRequest())).resolves.toBeUndefined();

			// then
			expect(service.list()).toEqual([]);
			expect(repliedEvents).toEqual([{ requestID: "request-1", sessionID: "session-1", reply: "allow" }]);
		});

		it("throws DeniedError when static rules deny a pattern", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "git commit", action: "deny" }]);

			// when
			const result = service.ask(createRequest());

			// then
			await expect(result).rejects.toEqual(new DeniedError(["git commit"]));
			expect(service.list()).toEqual([]);
		});

		it("throws DeniedError when approved rules deny a pattern", async () => {
			// given
			const { service } = createService([], [{ permission: "bash", pattern: "git commit", action: "deny" }]);

			// when
			const result = service.ask(createRequest());

			// then
			await expect(result).rejects.toEqual(new DeniedError(["git commit"]));
			expect(service.list()).toEqual([]);
		});

		it("throws DeniedError with only the denied patterns when multiple patterns provided", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "rm *", action: "deny" }]);
			const request = createRequest({ patterns: ["git commit", "rm -rf tmp", "ls"] });

			// when
			const result = service.ask(request);

			// then
			await expect(result).rejects.toEqual(new DeniedError(["rm -rf tmp"]));
			expect(service.list()).toEqual([]);
		});

		it("creates a pending entry when at least one pattern needs confirmation", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "git status", action: "allow" }]);
			const request = createRequest({ patterns: ["git status", "git commit"] });

			// when
			const askPromise = service.ask(request);
			const [pendingRequest] = service.list();
			service.reply({ requestID: request.id, reply: "once" });

			// then
			expect(pendingRequest).toEqual(request);
			await expect(askPromise).resolves.toBeUndefined();
		});

		it("emits asked event when request becomes pending", async () => {
			// given
			const { service, askedEvents } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest();

			// when
			const askPromise = service.ask(request);
			service.reply({ requestID: request.id, reply: "once" });

			// then
			expect(askedEvents).toEqual([request]);
			await expect(askPromise).resolves.toBeUndefined();
		});

		it("generates an id when request id is omitted", async () => {
			// given
			const { service, askedEvents } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);

			// when
			const askPromise = service.ask({
				sessionID: "session-1",
				permission: "bash",
				patterns: ["git commit"],
				always: ["git *"],
				metadata: {},
			});
			const [pendingRequest] = service.list();

			// then
			expect(pendingRequest?.id).toBe("permission-1");
			expect(askedEvents[0]?.id).toBe("permission-1");
			service.reply({ requestID: pendingRequest.id, reply: "once" });
			await expect(askPromise).resolves.toBeUndefined();
		});

		it("increments generated ids for later requests", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);

			// when
			const firstPromise = service.ask({
				sessionID: "session-1",
				permission: "bash",
				patterns: ["git commit"],
				always: ["git *"],
				metadata: {},
			});
			const firstID = service.list()[0]?.id;
			service.reply({ requestID: firstID ?? "", reply: "once" });
			await firstPromise;

			const secondPromise = service.ask({
				sessionID: "session-1",
				permission: "bash",
				patterns: ["git push"],
				always: ["git *"],
				metadata: {},
			});
			const secondID = service.list()[0]?.id;
			service.reply({ requestID: secondID ?? "", reply: "once" });

			// then
			expect(firstID).toBe("permission-1");
			expect(secondID).toBe("permission-2");
			await expect(secondPromise).resolves.toBeUndefined();
		});
	});

	describe("reply once", () => {
		it("resolves the pending promise for once replies", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest();
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: request.id, reply: "once" });

			// then
			await expect(askPromise).resolves.toBeUndefined();
		});

		it("removes the request from the pending list after once reply", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest();
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: request.id, reply: "once" });

			// then
			await expect(askPromise).resolves.toBeUndefined();
			expect(service.list()).toEqual([]);
		});

		it("emits replied event for once replies", async () => {
			// given
			const { service, repliedEvents } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest();
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: request.id, reply: "once" });

			// then
			await expect(askPromise).resolves.toBeUndefined();
			expect(repliedEvents).toEqual([{ requestID: request.id, sessionID: request.sessionID, reply: "once" }]);
		});
	});

	describe("reply always", () => {
		it("resolves the original pending promise for always replies", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest({ always: ["git *"] });
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: request.id, reply: "always" });

			// then
			await expect(askPromise).resolves.toBeUndefined();
		});

		it("appends always patterns to approved rules", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest({ always: ["git *", "gh *"] });
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: request.id, reply: "always" });

			// then
			await expect(askPromise).resolves.toBeUndefined();
			expect(service.getApproved()).toEqual([
				{ permission: "bash", pattern: "git *", action: "allow" },
				{ permission: "bash", pattern: "gh *", action: "allow" },
			]);
		});

		it("auto-resolves other pending requests in the same session when always covers them", async () => {
			// given
			const { service, repliedEvents } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const firstRequest = createRequest({ id: "request-1", patterns: ["git commit"], always: ["git *"] });
			const secondRequest = createRequest({ id: "request-2", patterns: ["git push"], always: ["git *"] });
			const firstPromise = service.ask(firstRequest);
			const secondPromise = service.ask(secondRequest);
			const settled = Promise.all([firstPromise, secondPromise]);

			// when
			service.reply({ requestID: firstRequest.id, reply: "always" });

			// then
			await expect(settled).resolves.toEqual([undefined, undefined]);
			expect(service.list()).toEqual([]);
			expect(repliedEvents).toEqual([
				{ requestID: "request-1", sessionID: "session-1", reply: "always" },
				{ requestID: "request-2", sessionID: "session-1", reply: "always" },
			]);
		});

		it("does not auto-resolve pending requests from another session", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const firstRequest = createRequest({
				id: "request-1",
				sessionID: "session-1",
				patterns: ["git commit"],
				always: ["git *"],
			});
			const secondRequest = createRequest({
				id: "request-2",
				sessionID: "session-2",
				patterns: ["git push"],
				always: ["git *"],
			});
			const firstPromise = service.ask(firstRequest);
			const secondPromise = service.ask(secondRequest);

			// when
			service.reply({ requestID: firstRequest.id, reply: "always" });

			// then
			await expect(firstPromise).resolves.toBeUndefined();
			expect(service.list()).toEqual([secondRequest]);
			service.reply({ requestID: secondRequest.id, reply: "once" });
			await expect(secondPromise).resolves.toBeUndefined();
		});

		it("does not auto-resolve requests whose patterns remain uncovered", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const firstRequest = createRequest({ id: "request-1", patterns: ["git commit"], always: ["git *"] });
			const secondRequest = createRequest({ id: "request-2", patterns: ["docker build"], always: ["docker *"] });
			const firstPromise = service.ask(firstRequest);
			const secondPromise = service.ask(secondRequest);

			// when
			service.reply({ requestID: firstRequest.id, reply: "always" });

			// then
			await expect(firstPromise).resolves.toBeUndefined();
			expect(service.list()).toEqual([secondRequest]);
			service.reply({ requestID: secondRequest.id, reply: "once" });
			await expect(secondPromise).resolves.toBeUndefined();
		});

		it("re-evaluates pending requests against static rules plus approved rules", async () => {
			// given
			const staticRuleset: Ruleset = [
				{ permission: "bash", pattern: "git status", action: "allow" },
				{ permission: "bash", pattern: "*", action: "ask" },
			];
			const { service } = createService(staticRuleset);
			const firstRequest = createRequest({ id: "request-1", patterns: ["git commit"], always: ["git *"] });
			const secondRequest = createRequest({
				id: "request-2",
				patterns: ["git status", "git push"],
				always: ["git *"],
			});
			const firstPromise = service.ask(firstRequest);
			const secondPromise = service.ask(secondRequest);
			const settled = Promise.all([firstPromise, secondPromise]);

			// when
			service.reply({ requestID: firstRequest.id, reply: "always" });

			// then
			await expect(settled).resolves.toEqual([undefined, undefined]);
			expect(service.list()).toEqual([]);
		});

		it("keeps existing approvals when adding new always approvals", async () => {
			// given
			const { service } = createService(
				[{ permission: "bash", pattern: "*", action: "ask" }],
				[{ permission: "bash", pattern: "gh *", action: "allow" }],
			);
			const request = createRequest({ always: ["git *"] });
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: request.id, reply: "always" });

			// then
			await expect(askPromise).resolves.toBeUndefined();
			expect(service.getApproved()).toEqual([
				{ permission: "bash", pattern: "gh *", action: "allow" },
				{ permission: "bash", pattern: "git *", action: "allow" },
			]);
		});
	});

	describe("reply reject", () => {
		it("rejects the original pending promise with RejectedError", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest();
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: request.id, reply: "reject" });

			// then
			await expect(askPromise).rejects.toBeInstanceOf(RejectedError);
		});

		it("rejects the original pending promise with CorrectedError when feedback provided", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const request = createRequest();
			const askPromise = service.ask(request);

			// when
			service.reply({ requestID: request.id, reply: "reject", message: "Use git status instead" });

			// then
			await expect(askPromise).rejects.toEqual(new CorrectedError("Use git status instead"));
		});

		it("cascade-rejects other pending requests in the same session", async () => {
			// given
			const { service, repliedEvents } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const firstRequest = createRequest({ id: "request-1", sessionID: "session-1" });
			const secondRequest = createRequest({ id: "request-2", sessionID: "session-1", patterns: ["git push"] });
			const settled = Promise.allSettled([service.ask(firstRequest), service.ask(secondRequest)]);

			// when
			service.reply({ requestID: firstRequest.id, reply: "reject" });

			// then
			const results = await settled;
			expect(results[0]?.status).toBe("rejected");
			expect(results[1]?.status).toBe("rejected");
			expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(RejectedError);
			expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(RejectedError);
			expect(service.list()).toEqual([]);
			expect(repliedEvents).toEqual([
				{ requestID: "request-1", sessionID: "session-1", reply: "reject" },
				{ requestID: "request-2", sessionID: "session-1", reply: "reject" },
			]);
		});

		it("does not cascade-reject pending requests from another session", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const firstRequest = createRequest({ id: "request-1", sessionID: "session-1" });
			const secondRequest = createRequest({ id: "request-2", sessionID: "session-2", patterns: ["git push"] });
			const firstPromise = service.ask(firstRequest);
			const secondPromise = service.ask(secondRequest);

			// when
			service.reply({ requestID: firstRequest.id, reply: "reject" });

			// then
			await expect(firstPromise).rejects.toBeInstanceOf(RejectedError);
			expect(service.list()).toEqual([secondRequest]);
			service.reply({ requestID: secondRequest.id, reply: "once" });
			await expect(secondPromise).resolves.toBeUndefined();
		});

		it("emits reject reply event for corrected rejections and cascade cancellations", async () => {
			// given
			const { service, repliedEvents } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const firstRequest = createRequest({ id: "request-1", sessionID: "session-1" });
			const secondRequest = createRequest({ id: "request-2", sessionID: "session-1", patterns: ["git push"] });
			const settled = Promise.allSettled([service.ask(firstRequest), service.ask(secondRequest)]);

			// when
			service.reply({ requestID: firstRequest.id, reply: "reject", message: "Try git status" });

			// then
			await settled;
			expect(repliedEvents).toEqual([
				{ requestID: "request-1", sessionID: "session-1", reply: "reject" },
				{ requestID: "request-2", sessionID: "session-1", reply: "reject" },
			]);
		});
	});

	describe("utility methods", () => {
		it("returns pending requests in insertion order", async () => {
			// given
			const { service } = createService([{ permission: "bash", pattern: "*", action: "ask" }]);
			const firstRequest = createRequest({ id: "request-1", patterns: ["git commit"] });
			const secondRequest = createRequest({ id: "request-2", patterns: ["git push"] });
			const firstPromise = service.ask(firstRequest);
			const secondPromise = service.ask(secondRequest);

			// when
			const pending = service.list();
			service.reply({ requestID: firstRequest.id, reply: "once" });
			service.reply({ requestID: secondRequest.id, reply: "once" });

			// then
			expect(pending).toEqual([firstRequest, secondRequest]);
			await expect(Promise.all([firstPromise, secondPromise])).resolves.toEqual([undefined, undefined]);
		});

		it("returns a defensive copy from getApproved", () => {
			// given
			const { service } = createService([], [{ permission: "bash", pattern: "git *", action: "allow" }]);

			// when
			const approved = service.getApproved();
			approved.push({ permission: "bash", pattern: "gh *", action: "allow" });

			// then
			expect(service.getApproved()).toEqual([{ permission: "bash", pattern: "git *", action: "allow" }]);
		});

		it("ignores replies for unknown request ids", () => {
			// given
			const { service, repliedEvents } = createService([{ permission: "bash", pattern: "*", action: "allow" }]);

			// when
			service.reply({ requestID: "missing", reply: "once" });

			// then
			expect(service.list()).toEqual([]);
			expect(repliedEvents).toEqual([]);
		});
	});
});
