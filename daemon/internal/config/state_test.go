package config_test

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/config"
)

func TestSaveStateThenLoadRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cockpitd", "state.json")
	want := config.State{
		State:          config.StateAwaitingClaim,
		ClaimCode:      "4F2K-9TQX",
		ClaimExpiresAt: 1700000600,
		Plane:          "https://plane.test",
		Hostname:       "lab-nbg1",
	}

	if err := config.SaveState(path, want); err != nil {
		t.Fatal(err)
	}

	got, err := config.LoadState(path)
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

	// An unredeemed claim code binds this box to a plane.
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", st.Mode().Perm())
	}
}

func TestSaveStateOverwritesLeavingNoClaimFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")

	if err := config.SaveState(path, config.State{
		State:          config.StateAwaitingClaim,
		ClaimCode:      "4F2K-9TQX",
		ClaimExpiresAt: 1700000600,
	}); err != nil {
		t.Fatal(err)
	}

	if err := config.SaveState(path, config.State{State: config.StateConnected, ServerID: "srv_1"}); err != nil {
		t.Fatal(err)
	}

	got, err := config.LoadState(path)
	if err != nil {
		t.Fatal(err)
	}

	// A truncating rewrite, not a merge: a code left behind here is a code the
	// operator would redeem into an error.
	if got.ClaimCode != "" || got.ClaimExpiresAt != 0 {
		t.Fatalf("got %+v, want no claim fields", got)
	}
}

func TestLoadStateMissingFileReportsNotExist(t *testing.T) {
	// The reader has to tell "no daemon" apart from any state a daemon could
	// publish, so this one is not swallowed the way a missing config is.
	_, err := config.LoadState(filepath.Join(t.TempDir(), "state.json"))
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("err = %v, want fs.ErrNotExist", err)
	}
}
