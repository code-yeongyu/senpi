package store_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

// TestWriteNeoThemeMergesOnly asserts the write path merges ONLY the neo.theme
// field into the current file, preserving every unrelated key (replicates
// persistScopedSettings settings-manager.ts:592-621 — never a whole-file
// overwrite).
func TestWriteNeoThemeMergesOnly(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	settingsPath := filepath.Join(agentDir, "settings.json")
	writeFile(t, settingsPath, `{"theme":"grok-day","defaultModel":"m","quietStartup":true}`)

	if err := store.WriteNeoTheme(cwd, agentDir, store.ScopeGlobal, "grok-night"); err != nil {
		t.Fatalf("WriteNeoTheme: %v", err)
	}

	m := rawJSON(t, settingsPath)
	if m["neo.theme"] != "grok-night" {
		t.Errorf("neo.theme = %v, want grok-night", m["neo.theme"])
	}
	if m["theme"] != "grok-day" {
		t.Errorf("classic theme mutated to %v, want grok-day preserved", m["theme"])
	}
	if m["defaultModel"] != "m" {
		t.Errorf("defaultModel lost: %v", m["defaultModel"])
	}
	if m["quietStartup"] != true {
		t.Errorf("quietStartup lost: %v", m["quietStartup"])
	}
}

// TestWriteNeverWritesClassicTheme asserts writing the neo skin NEVER creates or
// mutates the classic "theme" key when it was absent.
func TestWriteNeverWritesClassicTheme(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	settingsPath := filepath.Join(agentDir, "settings.json")
	writeFile(t, settingsPath, `{"defaultModel":"m"}`)

	if err := store.WriteNeoTheme(cwd, agentDir, store.ScopeGlobal, "grok-night"); err != nil {
		t.Fatalf("WriteNeoTheme: %v", err)
	}

	m := rawJSON(t, settingsPath)
	if _, ok := m["theme"]; ok {
		t.Errorf("classic theme key was written: %v (must never write classic theme)", m["theme"])
	}
	if m["neo.theme"] != "grok-night" {
		t.Errorf("neo.theme = %v, want grok-night", m["neo.theme"])
	}
}

// TestWriteCreatesFileWhenAbsent asserts a first write creates settings.json
// containing only the neo field (withLock creates the dir/file on demand).
func TestWriteCreatesFileWhenAbsent(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	settingsPath := filepath.Join(agentDir, "settings.json")

	if err := store.WriteNeoTheme(cwd, agentDir, store.ScopeGlobal, "grok-night"); err != nil {
		t.Fatalf("WriteNeoTheme: %v", err)
	}
	m := rawJSON(t, settingsPath)
	if m["neo.theme"] != "grok-night" {
		t.Errorf("neo.theme = %v, want grok-night", m["neo.theme"])
	}
}

// TestWriteProjectScope asserts scope=project targets <cwd>/.senpi/settings.json.
func TestWriteProjectScope(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	projPath := filepath.Join(cwd, ".senpi", "settings.json")

	if err := store.WriteNeoTheme(cwd, agentDir, store.ScopeProject, "grok-night"); err != nil {
		t.Fatalf("WriteNeoTheme(project): %v", err)
	}
	m := rawJSON(t, projPath)
	if m["neo.theme"] != "grok-night" {
		t.Errorf("project neo.theme = %v, want grok-night", m["neo.theme"])
	}
}

// TestLockfileIsDirectory asserts the write acquires the mutex the SAME way
// proper-lockfile does: a directory named "<settings.json>.lock". This is what
// makes the Go writer and a classic senpi mutually exclusive.
func TestLockfileIsDirectory(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	settingsPath := filepath.Join(agentDir, "settings.json")
	writeFile(t, settingsPath, `{"theme":"grok-day"}`)

	lockPath := settingsPath + ".lock"

	// Simulate a classic senpi holding the lock: create the lock DIRECTORY.
	if err := os.Mkdir(lockPath, 0o755); err != nil {
		t.Fatalf("pre-create lock dir: %v", err)
	}

	// The Go writer must fail fast (or block) while the lock is held. With the
	// retry budget exhausted it returns an error rather than clobbering.
	err := store.WriteNeoTheme(cwd, agentDir, store.ScopeGlobal, "grok-night")
	if err == nil {
		t.Fatalf("WriteNeoTheme succeeded while lock dir held; expected contention error")
	}

	// The held lock must be untouched and the file must NOT have been written.
	if _, statErr := os.Stat(lockPath); statErr != nil {
		t.Errorf("held lock dir was removed by the writer: %v", statErr)
	}
	m := rawJSON(t, settingsPath)
	if _, ok := m["neo.theme"]; ok {
		t.Errorf("writer clobbered the file while lock held: %v", m)
	}
	if err := os.Remove(lockPath); err != nil {
		t.Fatalf("cleanup lock dir: %v", err)
	}
}

// TestConcurrentWriterRace runs the Go writer against a simulated classic
// writer, both contending on the SAME mkdir-directory lock, and asserts the
// final file is well-formed JSON with BOTH writers' fields intact (no partial
// write, no lost update from one clobbering the other).
func TestConcurrentWriterRace(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	settingsPath := filepath.Join(agentDir, "settings.json")
	writeFile(t, settingsPath, `{"defaultModel":"m"}`)

	const iterations = 40
	var wg sync.WaitGroup
	wg.Add(2)

	// Go writer: repeatedly persists neo.theme via the real write protocol.
	errCh := make(chan error, iterations*2)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			if err := store.WriteNeoTheme(cwd, agentDir, store.ScopeGlobal, "grok-night"); err != nil {
				errCh <- err
			}
		}
	}()

	// Simulated classic senpi writer: acquires the SAME mkdir lock, does a
	// read-merge-write of a classic-only field, releases. Uses the exported
	// primitive so both racers share identical lock semantics.
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			err := store.WithSettingsLock(settingsPath, func(current string) (string, error) {
				m := map[string]any{}
				if current != "" {
					if err := json.Unmarshal([]byte(current), &m); err != nil {
						return "", err
					}
				}
				m["theme"] = "grok-day"
				b, err := json.MarshalIndent(m, "", "  ")
				if err != nil {
					return "", err
				}
				return string(b), nil
			})
			if err != nil {
				errCh <- err
			}
		}
	}()

	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatalf("race iteration error: %v", err)
		}
	}

	// Final file must be valid JSON (no torn write) with both fields present.
	m := rawJSON(t, settingsPath)
	if m["neo.theme"] != "grok-night" {
		t.Errorf("final neo.theme = %v, want grok-night", m["neo.theme"])
	}
	if m["theme"] != "grok-day" {
		t.Errorf("final classic theme = %v, want grok-day (classic writer preserved)", m["theme"])
	}
	if m["defaultModel"] != "m" {
		t.Errorf("final defaultModel = %v, want m (original preserved)", m["defaultModel"])
	}

	// No lock directory should be left behind after all writers finish.
	if _, err := os.Stat(settingsPath + ".lock"); !os.IsNotExist(err) {
		t.Errorf("lock dir leaked after race: err=%v", err)
	}
}
