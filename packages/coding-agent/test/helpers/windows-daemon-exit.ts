import { spawn } from "node:child_process";
import { once } from "node:events";

/** Open handles to the owned supervisor and its descendants BEFORE the stop reparents them. */
export async function waitForWindowsDaemonExit(pid: number, stop: () => Promise<void>): Promise<void> {
	const script = `
$ErrorActionPreference = "Stop"
$rows = Get-CimInstance Win32_Process
$ids = [System.Collections.Generic.HashSet[int]]::new()
$null = $ids.Add(${pid})
do {
  $grew = $false
  foreach ($row in $rows) {
    if ($ids.Contains([int]$row.ParentProcessId) -and !$ids.Contains([int]$row.ProcessId)) {
      $parent = $rows | Where-Object { $_.ProcessId -eq $row.ParentProcessId }
      if ($parent -and $row.CreationDate -ge $parent.CreationDate) {
        $null = $ids.Add([int]$row.ProcessId)
        $grew = $true
      }
    }
  }
} while ($grew)
$handles = @()
foreach ($id in $ids) {
  try {
    $process = [System.Diagnostics.Process]::GetProcessById($id)
    $null = $process.Handle
    $handles += $process
  } catch [System.ArgumentException] {}
}
[Console]::Out.WriteLine("WATCHING")
foreach ($process in $handles) {
  if (!$process.WaitForExit(30000)) { throw "owned daemon process $($process.Id) did not exit" }
  $process.Dispose()
}`;
	const watcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const closed = once(watcher, "close", { signal: AbortSignal.timeout(60_000) });
	let stderr = "";
	watcher.stderr.on("data", (data: Buffer) => {
		stderr += data.toString();
	});
	try {
		await new Promise<void>((resolve, reject) => {
			let stdout = "";
			watcher.stdout.on("data", (data: Buffer) => {
				stdout += data.toString();
				if (stdout.includes("WATCHING")) resolve();
			});
			watcher.once("error", reject);
			watcher.once("close", () => reject(new Error(`daemon exit watcher stopped before subscribing: ${stderr}`)));
		});
		await stop();
		const [code] = await closed;
		if (code !== 0) throw new Error(`owned daemon exit was not observed: ${stderr}`);
	} finally {
		if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill("SIGKILL");
		await closed;
	}
}
