package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/config"
)

func TestLoadMissingFileIsNotAnError(t *testing.T) {
	f, err := config.Load(filepath.Join(t.TempDir(), "nope", "config.json"))
	if err != nil {
		t.Fatal(err)
	}

	if f != (config.File{}) {
		t.Fatalf("f = %+v, want zero", f)
	}
}

func TestSaveThenLoadRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cockpitd", "config.json")
	want := config.File{Plane: "https://plane.test", ServerID: "srv_1", Credential: "ck_cred_live"}

	if err := config.Save(path, want); err != nil {
		t.Fatal(err)
	}

	got, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	// It holds a credential.
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", st.Mode().Perm())
	}
}

func TestLoadRejectsMalformedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")

	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := config.Load(path); err == nil {
		t.Fatal("want error")
	}
}
