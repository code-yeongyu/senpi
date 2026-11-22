# Eval timing benchmark

Run from the repository root after installing dependencies and building both
checkouts:

```sh
bun run --cwd packages/senpi-codemode bench -- --base /path/to/base --head /path/to/head --blocks 3 --reps 15 --out bench-report.json
```

The defaults (3 blocks x 15 repetitions = 45 adjacent pairs per row) take about 2.5 hours
for the five-runtime matrix; most of that is the fixed-clock detach, interrupt and
Julia output workloads.

Both targets run on the same machine, with five unmeasured warm-up cells.
Each runtime has four isolated retained host processes: base, head, and two
independent base instances for calibration. Only one receives a measurement
request at a time. Each scenario first rehearses once without retaining a
sample, then measures `--reps` repetitions per side. Repetitions are paired
adjacently, reversing both comparison and calibration order across repetitions
and blocks; an entire scenario suite never separates a pair.
Cold-start trials use fresh kernels and have no discarded scenario rehearsal.
A separate A/A calibration runs in the same invocation.

## Estimator and thresholds

Host noise on a shared machine is time-correlated: two adjacent repetitions move
together, while per-side minima taken from different moments do not. Each row
(runtime x scenario x CPU/wall/p95) is therefore judged on its adjacent pairs:
the gated statistic is the 25% trimmed mean of the paired log ratios across all
blocks and repetitions (`bench-stats.ts`).

Every row gets its threshold from its own calibration pairs through one rule,
`rowNoiseBand` in `bench-threshold.ts`: band = |A/A trimmed-mean offset| +
`THRESHOLD_Z` (4) standard errors of that trimmed mean. Only the constant differs
between rows; the rule is the same for all of them. The threshold is the band
capped at `MAX_BAND` (0.05). A row FAILs when its paired ratio exceeds
`1 + band`. A row whose band is above 0.05 is NOISE-LIMITED: it can still fail
beyond its own noise, but it never passes, and the run is INCONCLUSIVE. The
report prints threshold, band, minimum detectable effect (MDE), ratio, median
paired ratio and verdict per row, then the PASS / NOISE-LIMITED / FAIL counts.

Each row's MDE is derived from its own measured A/A band:
`minimumDetectableEffect(band) = band` (the floor variant; no extra z). A row
FAILs only when its paired ratio exceeds `1 + band`, so a true slowdown below the
band is not flagged on average and one at the band is flagged about half the
time. A clean row's MDE equals its threshold (at most 0.05); a noise-limited row's
MDE is above 0.05 and states the largest slowdown that row could miss. A run with
no FAIL row and at least one noise-limited row ends with the claim "no regression
detected; rows marked noise-limited can only detect slowdowns above their stated
MDE".

### Absolute head budgets

A few rows can't meet the base-ratio gate by design, so `scripts/bench-head-budget.ts` judges them on the head alone, and the printed table marks them `(head budget)`. `crash-queue-100` on Ruby and Julia is one: its base never recovered from the crash (every queued cell failed, no replacement, about 20 ms), so the head/base ratio compared a failure path with the real work. Every head repetition must report the recovered observations (100 queued cells run, each once, after one replacement). The head's median wall and cpu must also stay under absolute ceilings, set at twice the measured head medians of a calm run, with the host named in the file. The ceilings are absolute, so rerun a budget failure on a calm host before treating it as a regression.

## What a run can claim on available hardware

The acceptance self-vs-self run (3 blocks x 15 repetitions, a quiet host on AC,
every block clear of other measured load) ended INCONCLUSIVE with 63 PASS, 57
NOISE-LIMITED and 0 FAIL of 120 rows. The noise-limited MDEs range from 0.052 to
0.503 (18 rows above 0.10, 8 above 0.20); every PASS row's MDE is at most 0.05.
The same measurement on a loaded host gave 23 PASS, 97 NOISE-LIMITED, 0 FAIL:
quieting the host halves the noise-limited count but does not reach exit 0, so
exit 0 is not reachable on the hardware available. Rescoring that quiet run with
`--inject-slow head:warm-cell-1000:1.25` (and `1.3`) exits 1 and names the
warm-cell-1000 rows (15 FAIL rows), and the forced A/A offset exits 3. Rescoring
it with `--band-scope global` gives 0 FAIL and exit 3: the shared band is the
noisiest row's 0.503, so every row is noise-limited. No block exceeded the
18-core ceiling (peak 1-minute load 13.36). The honest ceiling is therefore 0
FAIL plus noise-limited labels plus each row's MDE: a true 1.25x regression is
caught, and a slowdown below a noise-limited row's MDE can go unnoticed.

`--band-scope global` switches to one band for every row: the largest
`rowNoiseBand` over all rows. The statistic is the same as row scope; only the
scope differs, so every row's shared band is at least its own and the global
scope never fails a clean row that row scope passes. (A percentile of the bare
A/A offsets would fail a fixed share of clean rows by construction.) It is the
only knob between the two policies.

A block is contaminated when any measurement's start or end 1-minute load, or
any of the block's host samples, exceeds the host's core count: beyond it,
runnable threads queue for a core and the measured time absorbs scheduler wait.
(macOS load also counts I/O-blocked threads, so a fractional ceiling would flag
quiet hosts.) A contaminated block is named in an INCONCLUSIVE line with its
peak load and first affected measurement, so a load burst on one side can never
feed a FAIL. Each measurement's side, repetition and order are retained in the
block's `measurements` list; the first side alternates on every repetition.

Exit codes: 0 PASS, 1 regression, 2 refused (load above 80 or stale build),
3 INCONCLUSIVE (missing runtime/scenario/sample, version mismatch, unavailable
accounting, failed workload, or a noise-limited row). The report retains individual
samples, observations, actual measurement ordering, block-start/block-end load,
per-repetition start/end load, power source, and runtime versions.
RSS and wall time remain load-dependent measurements.

## CPU accounting

The host's `process.cpuUsage()` already includes its JavaScript worker threads.
No thread total is added to it. Subprocess kernels report their own cumulative
CPU through ordinary cells. The benchmark overrides only the interpreter command
using the existing detected-interpreter option; production source is untouched.
A dependency-free Python launcher preserves the interpreter's transport and kill
group. A collector in a separate process group records POSIX `wait4` usage even
when the host force-kills the entire kernel group. Python's PID-directed signals
are forwarded; Ruby and Julia retain their existing group-directed signals.

Snapshots are joined by PID. For an interpreter that dies during the window,
its final receipt minus its starting snapshot contributes alongside the replacement's
CPU. Missing final usage invalidates the run; it is never reported as zero.
Receipt creation is atomic; the waiter then connects to a Unix socket the collector
listens on before any kernel starts (directory watchers subscribe asynchronously on
macOS and can miss an early receipt);
missing receipts have a bounded watchdog. The launcher and collector are benchmark
infrastructure and their own CPU is excluded.
Windows lacks this waiter and is explicitly unsupported for full process accounting.

The detach wall interval ends when eval returns its detached handle. Its CPU
interval additionally includes cancellation and the following scalar readiness
cell, since a sleeping interpreter cannot run a transport probe concurrently.
Interrupt CPU likewise includes the terminal probe and any replacement startup.
These scopes are identical on both sides and recorded separately from wall time.

Python's current `print` implementation buffers a whole cell into one frame.
The streamed-output and interrupt-readiness fixtures therefore use the existing
prelude `text` emitter: this measures bounded stdout frames and supplies a signal
while the cell is running, rather than after its buffered output is released.
Julia uses its prelude's synchronous `print`, not the file-tool helper named
`write` or the asynchronously forwarded Base `println`. Its GC fixture uses a
Julia-owned byte vector with native `memset`, matching the other languages'
native bulk fills rather than measuring an interpreted element-by-element loop.
The GC scenario gets a fresh kernel with the existing 150 MiB test's 32 MiB
watermark, 64 MiB notice threshold, and disabled ceiling. JavaScript uses the
existing constructor's `onMemoryCollected` callback and waits for native idle
collection, matching the repository's memory test without sleeps. Its count
includes cell-reported and observed idle collections. Subprocess counts are
cell-reported policy collections; `forcedCollections` separately records the
explicit collection before their final live-memory observation.

The crash workload reports current behavior, including failed queued cells on
fail-closed runtimes; it does not pretend to implement later kernel recovery.
It records executions, generations, replacements, settled entries, and remaining
children. Existing runtime memory reports can be unavailable; missing memory
observations are `null`, not zero.

## Controlled checks

`--runtimes js-bun,js-node,py` explicitly selects a subset for diagnosis; such a
report does not establish the full five-runtime gate. Unknown or empty selections
are rejected. The default manifest requires Bun, Node, Python, Ruby, and Julia.
Only explicitly optional features introduced by later plan nodes are recorded
as not present on head when absent on both targets. A missing required workload
is inconclusive even when both sides omit it.

`--inject-slow head:warm-cell-1000:1.3` scales only that workload's head comparison
samples after measurement. It is a comparator fault injection, not a CPU burner.
An unknown scenario name is rejected, and an injection that matches no series
measured on both sides is refused (exit 2), so a typo can never pass vacuously.
`--inject-loadavg 81` exercises refusal without starting a workload.
`--inject-aa-offset 1.08` scales the second calibration instance of every row,
forcing an eight-percent A/A offset (an excessive band, so INCONCLUSIVE).

`--rescore bench-report.json` re-judges a saved measurement with the same
comparator and no new samples, so `--band-scope`, `--inject-slow` and
`--inject-aa-offset` can be evaluated on one expensive run. A report that
already carries injected samples is refused. Each block records its start load,
power source and, on macOS, seconds since the last keyboard or pointer input.
