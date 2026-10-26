import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import type { ManagedCommand } from "../../../../modes/rpc/tool-child/managed-launch-process.ts";
import {
	ManagedLaunchError,
	type SessionLaunchSupervisor,
} from "../../../../modes/rpc/tool-child/session-launch-supervisor.ts";

/** Probe processes use call ownership, never the registered service's owner key. */
export async function probeSessionService(
	supervisor: SessionLaunchSupervisor,
	command: ManagedCommand,
	absentMessage: string,
): Promise<"available" | "missing"> {
	const callId = `service-probe:${randomUUID()}`;
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		void supervisor
			.cancel(callId)
			.then(
				() =>
					deadline.reject(new ManagedLaunchError("managed_service_probe_timeout", "the service probe timed out")),
				deadline.reject,
			);
	}, 10_000);
	timer.unref();
	try {
		const launch = await Promise.race([supervisor.start(command, callId), deadline.promise]);
		const code = await Promise.race([launch.completed, deadline.promise]);
		if (code === 0) return "available";
		const log = await open(command.logPath, "r");
		let output: string;
		try {
			const size = (await log.stat()).size;
			const bytes = Buffer.alloc(Math.min(size, 8_192));
			const read = await log.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
			output = bytes.subarray(0, read.bytesRead).toString("utf8").trim();
		} finally {
			await log.close();
		}
		if (output.includes(absentMessage)) return "missing";
		throw new ManagedLaunchError(
			"managed_service_probe_failed",
			output || `the service probe exited with code ${code}`,
		);
	} finally {
		clearTimeout(timer);
		await supervisor.cancel(callId);
		await rm(command.logPath, { force: true });
	}
}
