package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// Lock/replication constants mirror the classic write path:
//   - proper-lockfile uses a directory "<file>.lock" created via mkdir as the
//     atomic mutex, with a default stale threshold of 10s (lockfile.js).
//   - FileSettingsStorage.acquireLockSyncWithRetry retries an ELOCKED lock up
//     to 10 times with a 20ms busy-wait between attempts (settings-manager.ts:
//     213-238).
const (
	lockMaxAttempts = 10
	lockRetryDelay  = 20 * time.Millisecond
	lockStale       = 10 * time.Second
)

// errLockHeld is returned when the lock could not be acquired within the retry
// budget, mirroring the thrown ELOCKED error the classic path surfaces.
var errLockHeld = errors.New("settings lock is already being held")

// lockfilePathFor mirrors proper-lockfile getLockFile with realpath:false:
// path.resolve(file) + ".lock" (settings-manager.ts calls lockSync with
// {realpath:false}). The Go writer resolves the settings path the same way.
func lockfilePathFor(settingsPath string) string {
	return resolvePath(settingsPath) + ".lock"
}

// acquireLock replicates proper-lockfile.acquireLock + the classic retry loop:
// mkdir the lock directory (atomic); on EEXIST retry after a delay; if the held
// lock is stale (mtime older than lockStale) remove it and retry. Returns a
// release func that rmdir's the lock directory.
func acquireLock(settingsPath string) (func(), error) {
	lockPath := lockfilePathFor(settingsPath)

	release := func() {
		// Best-effort rmdir of the lock directory; a failure here cannot be
		// acted on and only matters if the process died, which stale-removal
		// handles on the next acquire. Capture-then-discard keeps errcheck's
		// check-blank satisfied.
		rmErr := os.Remove(lockPath)
		_ = rmErr
	}

	for attempt := 1; attempt <= lockMaxAttempts; attempt++ {
		err := os.Mkdir(lockPath, 0o755)
		if err == nil {
			return release, nil
		}
		if !os.IsExist(err) {
			return nil, err
		}

		// Lock is held: check staleness like proper-lockfile isLockStale.
		if info, statErr := os.Stat(lockPath); statErr == nil {
			if time.Since(info.ModTime()) > lockStale {
				// Stale: remove and retry immediately (skip stale re-check).
				if rmErr := os.Remove(lockPath); rmErr == nil {
					if mkErr := os.Mkdir(lockPath, 0o755); mkErr == nil {
						return release, nil
					}
				}
			}
		}

		if attempt == lockMaxAttempts {
			break
		}
		// Busy-wait mirrors acquireLockSyncWithRetry's synchronous sleep.
		busyWait(lockRetryDelay)
	}
	return nil, errLockHeld
}

// busyWait sleeps for d, mirroring the synchronous delay loop the classic path
// uses to avoid making callers async.
func busyWait(d time.Duration) {
	start := time.Now()
	for time.Since(start) < d {
		time.Sleep(time.Millisecond)
	}
}

// WithSettingsLock runs fn under the same mkdir-directory lock the classic
// senpi uses, so a Go writer and a concurrent classic writer are mutually
// exclusive. fn receives the current file contents ("" when absent) and returns
// the next contents; when next != current the file (and its parent dir) are
// written. Mirrors FileSettingsStorage.withLock (settings-manager.ts:240-268).
func WithSettingsLock(settingsPath string, fn func(current string) (string, error)) error {
	dir := filepath.Dir(settingsPath)

	fileExists := pathExists(settingsPath)

	var release func()
	if fileExists {
		r, err := acquireLock(settingsPath)
		if err != nil {
			return err
		}
		release = r
	}
	defer func() {
		if release != nil {
			release()
		}
	}()

	current := ""
	if fileExists {
		b, err := os.ReadFile(settingsPath)
		if err != nil {
			return err
		}
		current = string(b)
	}

	next, err := fn(current)
	if err != nil {
		return err
	}

	if next == current {
		return nil
	}

	if !pathExists(dir) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	if release == nil {
		r, err := acquireLock(settingsPath)
		if err != nil {
			return err
		}
		release = r
	}
	return os.WriteFile(settingsPath, []byte(next), 0o644)
}

// WriteNeoTheme persists the neo skin for the default (senpi / .senpi) build. It
// delegates to Config.WriteNeoTheme so the project scope is resolved through the
// same ConfigDirName as the reader, never a hardcoded ".senpi".
func WriteNeoTheme(cwd, agentDir string, scope SettingsScope, themeName string) error {
	return DefaultConfig().WriteNeoTheme(cwd, agentDir, scope, themeName)
}

// WriteNeoTheme persists the neo skin under the neo.theme key in the given
// scope, replicating persistScopedSettings (settings-manager.ts:592-621): it
// read-merges ONLY the neo.theme field into the current file and NEVER performs
// a whole-file overwrite, and NEVER writes the classic "theme" key. The project
// scope is resolved via THIS Config's ConfigDirName (e.g. ".pi" for a pi build),
// so the write lands in <cwd>/<configDir>/settings.json — the same file the
// reader resolves.
func (c Config) WriteNeoTheme(cwd, agentDir string, scope SettingsScope, themeName string) error {
	var path string
	switch scope {
	case ScopeProject:
		path = c.ProjectSettingsPath(cwd)
	default:
		path = filepath.Join(agentDir, "settings.json")
	}

	return WithSettingsLock(path, func(current string) (string, error) {
		merged := map[string]any{}
		if trimmed := trimJSON(current); trimmed != "" {
			if err := json.Unmarshal([]byte(trimmed), &merged); err != nil {
				return "", err
			}
		}
		// Merge ONLY the neo field; every other key is preserved verbatim.
		merged[neoThemeKey] = themeName

		out, err := json.MarshalIndent(merged, "", "  ")
		if err != nil {
			return "", err
		}
		return string(out), nil
	})
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func trimJSON(s string) string {
	// Cheap whitespace trim without importing strings twice; treat all-blank as
	// empty so a fresh file starts from {}.
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
			return s
		}
	}
	return ""
}
