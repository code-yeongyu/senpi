import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { arch, availableParallelism, freemem, homedir, loadavg, platform, totalmem } from "node:os";
import { join } from "node:path";
import { MachineOpError } from "../errors.ts";
import { gated } from "../policy/gate.ts";
import type { HostFacts, InfoOps, MessageResult, OpContext, ProcessHandle, ProcessInfo } from "../types.ts";

const TOPIC = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function ownProcessInfo(lastOpAtMs: number | undefined): ProcessInfo {
	const cpu = process.cpuUsage();
	return {
		pid: process.pid,
		startedAtMs: Math.round(Date.now() - process.uptime() * 1000),
		cpuTimeMs: Math.round((cpu.user + cpu.system) / 1000),
		rssBytes: process.memoryUsage().rss,
		command: process.argv.join(" "),
		...(lastOpAtMs !== undefined ? { lastOpAtMs } : {}),
	};
}

function psField(pid: number, field: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("ps", ["-o", `${field}=`, "-p", String(pid)], (error, stdout) => {
			if (error) reject(new MachineOpError("not_found", `no process ${pid}`, { cause: error }));
			else resolve(stdout.trim());
		});
	});
}

/** `[[dd-]hh:]mm:ss` (ps etime/time) to milliseconds. */
function psDurationMs(value: string): number {
	const [days, rest] = value.includes("-") ? value.split("-") : ["0", value];
	const parts = rest.split(":").map(Number);
	while (parts.length < 3) parts.unshift(0);
	const [hours, minutes, seconds] = parts;
	return ((Number(days) * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000;
}

/** Total and free-to-this-user bytes of the volume holding the home directory; empty when statfs fails. */
function homeDisk(): { diskTotalBytes?: number; diskFreeBytes?: number } {
	try {
		const fs = statfsSync(homedir());
		return { diskTotalBytes: fs.blocks * fs.bsize, diskFreeBytes: fs.bavail * fs.bsize };
	} catch {
		return {};
	}
}

async function otherProcessInfo(pid: number): Promise<ProcessInfo> {
	const [rssKiB, cpuTime, elapsed, command] = await Promise.all([
		psField(pid, "rss"),
		psField(pid, "time"),
		psField(pid, "etime"),
		psField(pid, "command"),
	]);
	if (command === "") throw new MachineOpError("not_found", `no process ${pid}`);
	return {
		pid,
		startedAtMs: Date.now() - psDurationMs(elapsed),
		cpuTimeMs: psDurationMs(cpuTime),
		rssBytes: Number(rssKiB) * 1024,
		command,
	};
}

export function createLocalInfoOps(options: {
	stateDir: string | undefined;
	handle: (id: string) => ProcessHandle | undefined;
	lastOpAtMs: () => number | undefined;
}): InfoOps {
	const stateDir = options.stateDir;
	/** topic -> the tail of its append chain, resolving to the last seq written. */
	const topics = new Map<string, Promise<number>>();
	return {
		async processInfo(req?: { pid?: number; handleId?: string }): Promise<ProcessInfo> {
			let pid = req?.pid;
			if (req?.handleId !== undefined) {
				const handle = options.handle(req.handleId);
				if (handle === undefined) throw new MachineOpError("not_found", `no handle ${req.handleId}`);
				pid = handle.pid;
			}
			if (pid === undefined || pid === process.pid) return ownProcessInfo(options.lastOpAtMs());
			return otherProcessInfo(pid);
		},

		host(): HostFacts {
			const [load1, load5, load15] = loadavg();
			return {
				os: platform(),
				arch: arch(),
				load1,
				load5,
				load15,
				cores: availableParallelism(),
				runtime: process.versions.bun !== undefined ? `bun ${process.versions.bun}` : `node ${process.version}`,
				memTotalBytes: totalmem(),
				memFreeBytes: freemem(),
				...homeDisk(),
			};
		},

		async message(req: { topic: string; body: unknown }, ctx: OpContext): Promise<MessageResult> {
			if (!TOPIC.test(req.topic)) throw new MachineOpError("invalid_argument", `invalid topic: ${req.topic}`);
			if (stateDir === undefined) throw new MachineOpError("invalid_argument", "info.message needs a stateDir");
			const inboxDir = join(stateDir, "machine", "inbox");
			return gated("info.message", req, ctx, async () => {
				const inboxPath = join(inboxDir, `${req.topic}.jsonl`);
				const previous =
					topics.get(req.topic) ??
					readFile(inboxPath, "utf8").then(
						(text) => text.split("\n").filter((line) => line.length > 0).length,
						() => 0,
					);
				const next = previous.then(async (lastSeq) => {
					const seq = lastSeq + 1;
					await mkdir(inboxDir, { recursive: true });
					const line = { seq, topic: req.topic, atMs: Date.now(), principal: ctx.principal, body: req.body };
					await appendFile(inboxPath, `${JSON.stringify(line)}\n`);
					return seq;
				});
				topics.set(
					req.topic,
					next.catch(() => previous),
				);
				return { accepted: true, seq: await next, inboxPath };
			});
		},
	};
}
