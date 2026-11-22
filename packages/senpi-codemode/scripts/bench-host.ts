import { runProcess } from "./bench-target.ts";

export async function powerSource(): Promise<string> {
	if (process.platform !== "darwin") return `${process.platform}: not reported`;
	const result = await runProcess(["pmset", "-g", "batt"], { cwd: process.cwd() }).catch(() => undefined);
	return /'([^']+)'/u.exec(result?.stdout ?? "")?.[1] ?? "unknown";
}

/** Seconds since the last keyboard or pointer input (macOS HIDIdleTime, nanoseconds); null where unavailable. */
export async function hostIdleSeconds(): Promise<number | null> {
	if (process.platform !== "darwin") return null;
	const result = await runProcess(["ioreg", "-c", "IOHIDSystem", "-d", "4"], { cwd: process.cwd() }).catch(
		() => undefined,
	);
	const nanoseconds = /"HIDIdleTime" = (\d+)/u.exec(result?.stdout ?? "")?.[1];
	return nanoseconds === undefined ? null : Math.round(Number(nanoseconds) / 1e9);
}
