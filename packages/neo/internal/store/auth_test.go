package store_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

// TestLoadAuthTypeMap mirrors auth-storage.ts:24-36: auth.json is a record of
// providerId -> {type: "api_key"|"oauth", ...}. The store returns ONLY the
// provider->type map and NEVER surfaces key material.
func TestLoadAuthTypeMap(t *testing.T) {
	agentDir := t.TempDir()
	writeFile(t, filepath.Join(agentDir, "auth.json"), `{
		"openai": {"type": "api_key", "key": "sk-SECRET-KEY-VALUE"},
		"anthropic": {"type": "oauth", "access": "AT-SECRET", "refresh": "RT-SECRET", "expires": 123},
		"weird": {"type": "unknown-scheme"}
	}`)

	auth, err := store.LoadAuth(agentDir)
	if err != nil {
		t.Fatalf("LoadAuth: %v", err)
	}
	if auth.Providers["openai"] != store.AuthTypeAPIKey {
		t.Errorf("openai type = %q, want api_key", auth.Providers["openai"])
	}
	if auth.Providers["anthropic"] != store.AuthTypeOAuth {
		t.Errorf("anthropic type = %q, want oauth", auth.Providers["anthropic"])
	}
	// Unknown type is still recorded as present but with its raw type string;
	// presence is what the picker needs.
	if !auth.HasProvider("openai") || !auth.HasProvider("anthropic") || !auth.HasProvider("weird") {
		t.Errorf("HasProvider missing an entry: %+v", auth.Providers)
	}
}

// canarySecret is a distinctive, clearly-fake literal placed in the fixture
// auth.json. It is NOT a real credential. The guardrail test asserts this exact
// string never survives into the value LoadAuth returns.
const canarySecret = "sk-ulw-canary-not-a-real-key-000"

// TestLoadAuthNeverLeaksKeys is the security guardrail: no key/token material
// from auth.json may survive into the value LoadAuth returns. The fixture seeds
// a distinctive canary secret across api_key, oauth access/refresh, and a nested
// object; the test then marshals the ENTIRE returned value to JSON and dumps it
// via %+v and asserts the canary appears in NEITHER. This can genuinely fail if
// LoadAuth ever carried raw credential material (proved by the labeled mutation
// proof in .omo/evidence/task-4-qa/red-auth-leak-mutation.txt).
func TestLoadAuthNeverLeaksKeys(t *testing.T) {
	agentDir := t.TempDir()
	writeFile(t, filepath.Join(agentDir, "auth.json"), `{
		"openai": {"type": "api_key", "key": "`+canarySecret+`"},
		"anthropic": {"type": "oauth", "access": "`+canarySecret+`", "refresh": "`+canarySecret+`", "meta": {"nested": "`+canarySecret+`"}}
	}`)

	auth, err := store.LoadAuth(agentDir)
	if err != nil {
		t.Fatalf("LoadAuth: %v", err)
	}

	// (1) Marshal the ENTIRE returned value and assert the canary is absent from
	// the serialized bytes. json.Marshal walks every exported field, so any field
	// that captured the key would surface here.
	marshaled, err := json.Marshal(auth)
	if err != nil {
		t.Fatalf("json.Marshal(auth): %v", err)
	}
	if bytes.Contains(marshaled, []byte(canarySecret)) {
		t.Fatalf("key material leaked into marshaled AuthInfo: %s", marshaled)
	}

	// (2) Assert the canary is absent from a full %+v dump too — this catches
	// unexported fields that json.Marshal would skip.
	dump := fmt.Sprintf("%+v", auth)
	if strings.Contains(dump, canarySecret) {
		t.Fatalf("key material leaked into %%+v dump of AuthInfo: %s", dump)
	}
}

// TestLoadAuthMissing yields empty map, no error.
func TestLoadAuthMissing(t *testing.T) {
	agentDir := t.TempDir()
	auth, err := store.LoadAuth(agentDir)
	if err != nil {
		t.Fatalf("LoadAuth on missing file: %v", err)
	}
	if len(auth.Providers) != 0 {
		t.Errorf("expected empty providers, got %v", auth.Providers)
	}
}
