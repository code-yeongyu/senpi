# Cache prefix diagnostics

Anthropic requests can opt in to local, content-free prefix fingerprints:

```sh
SENPI_DEBUG_CACHE_PREFIX=/absolute/private/run-directory senpi
```

The flag is off by default. Unset, empty, and `0` write nothing. Any other
value names the output directory; use an absolute private run directory.
The file is `cache-prefix.jsonl` there. New directories use mode 0700 and new files 0600.
Use a task-owned private directory and remove the records when finished.

Each JSON line records the final Anthropic request, after payload hooks and
sanitizers, immediately before each transport attempt, including fallbacks.
It contains ordered SHA-256 hashes and UTF-8 JSON byte lengths for system
sections, tools (including a separate input-schema fingerprint), messages
and their content blocks. Array positions preserve tool order without
recording tool names. Checkpoints are coordinates into those arrays.
The opaque partition fingerprint includes provider, model, endpoint and
the sorted beta-header set. No raw content, identifiers, schemas, headers
or credentials are stored. A hash is not encryption; keep records private.

Compare tools first, then system sections, then conversation blocks, using
their positions to find the earliest changed hash. Compare checkpoint
coordinates separately from content hashes and compare the partition before
attributing a cache miss to prompt mutation. An appended block is ordinary
conversation growth, not a rewrite. These records do not establish the cause
of cache misses in requests captured before the flag was enabled.
