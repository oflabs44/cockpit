package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/config"
)

func writeState(t *testing.T, s config.State) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "state.json")

	if err := config.SaveState(path, s); err != nil {
		t.Fatal(err)
	}

	return path
}

func TestClaimRendersTheBlockTheDaemonPublished(t *testing.T) {
	path := writeState(t, config.State{
		State:          config.StateAwaitingClaim,
		ClaimCode:      "4F2K-9TQX",
		ClaimExpiresAt: 1700000600,
		Plane:          "https://plane.test",
		Hostname:       "lab-nbg1",
	})

	out := &bytes.Buffer{}
	now := func() time.Time { return time.Unix(1700000000, 0) }

	if err := runClaim([]string{"--state", path}, out, now); err != nil {
		t.Fatal(err)
	}

	got := out.String()

	for _, want := range []string{"4F2K-9TQX", "https://plane.test", "lab-nbg1", "10 minutes"} {
		if !strings.Contains(got, want) {
			t.Fatalf("block does not mention %q:\n%s", want, got)
		}
	}
}

func TestClaimSaysSoWhenAlreadyBound(t *testing.T) {
	path := writeState(t, config.State{
		State:    config.StateConnected,
		ServerID: "srv_1",
		Plane:    "https://plane.test",
		Hostname: "lab-nbg1",
	})

	out := &bytes.Buffer{}

	// Being bound is a success, not an error: it is the state the operator was
	// working towards.
	if err := runClaim([]string{"--state", path}, out, time.Now); err != nil {
		t.Fatal(err)
	}

	got := out.String()

	if !strings.Contains(got, "already bound") || !strings.Contains(got, "srv_1") {
		t.Fatalf("output = %q, want it to say the box is bound as srv_1", got)
	}

	if strings.Contains(got, "Claim code") {
		t.Fatalf("output = %q, want no claim block", got)
	}
}

func TestClaimSaysSoWhenNoLiveCodeIsPublished(t *testing.T) {
	// Enrolled and offline, a code that has just aged out, a daemon still
	// starting: one answer for all of them, because the operator does the same
	// thing in each case — look again, then read the journal.
	path := writeState(t, config.State{
		State:    config.StateDisconnected,
		ServerID: "srv_1",
		Plane:    "https://plane.test",
		Hostname: "lab-nbg1",
	})

	out := &bytes.Buffer{}

	err := runClaim([]string{"--state", path}, out, time.Now)
	if err == nil {
		t.Fatalf("err = nil, want a failure; output was %q", out)
	}

	if !strings.Contains(err.Error(), "no claim code is on offer") {
		t.Fatalf("err = %q, want it to say there is no code", err)
	}

	if strings.Contains(out.String(), "Claim code") {
		t.Fatalf("output = %q, want no claim block", out)
	}
}

func TestClaimHelpIsNotAnError(t *testing.T) {
	if err := runClaim([]string{"-h"}, &bytes.Buffer{}, time.Now); err != nil {
		t.Fatalf("err = %v, want nil: usage was asked for, and it was printed", err)
	}
}

func TestClaimFallsBackToTheRootStatePathWhenNotRoot(t *testing.T) {
	// config.StatePath() branches on the reader's euid, so an operator without
	// sudo looks in their own home for a file the daemon writes into a 0700
	// runtime directory. Telling them a healthy box is not running is worse
	// than useless.
	root := writeState(t, config.State{
		State:    config.StateConnected,
		ServerID: "srv_1",
		Plane:    "https://plane.test",
		Hostname: "lab-nbg1",
	})

	restore := rootStatePath
	rootStatePath = root

	defer func() { rootStatePath = restore }()

	out := &bytes.Buffer{}

	if err := runClaim(nil, out, time.Now); err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(out.String(), "srv_1") {
		t.Fatalf("output = %q, want the state the root daemon published", out)
	}
}

func TestClaimNamesTheDaemonsPathWhenNeitherExists(t *testing.T) {
	// A stopped daemon: systemd took /run/cockpitd with it. The operator needs
	// to be told about the path a daemon writes, not the per-user one this
	// reader happened to default to.
	restore := rootStatePath
	rootStatePath = filepath.Join(t.TempDir(), "run", "state.json")

	defer func() { rootStatePath = restore }()

	err := runClaim(nil, &bytes.Buffer{}, time.Now)
	if err == nil {
		t.Fatal("err = nil, want a failure")
	}

	if !strings.Contains(err.Error(), rootStatePath) {
		t.Fatalf("err = %q, want it to name %q", err, rootStatePath)
	}
}

func TestClaimPointsAtSudoWhenTheStateFileIsUnreadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads everything, so there is no permission error to see")
	}

	path := writeState(t, config.State{State: config.StateConnected})

	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatal(err)
	}

	err := runClaim([]string{"--state", path}, &bytes.Buffer{}, time.Now)
	if err == nil {
		t.Fatal("err = nil, want a permission failure")
	}

	if !strings.Contains(err.Error(), "sudo cockpitd claim") {
		t.Fatalf("err = %q, want it to point at sudo", err)
	}
}

func TestClaimPointsAtTheJournalWhenNoStateWasPublished(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")

	err := runClaim([]string{"--state", path}, &bytes.Buffer{}, time.Now)
	if err == nil {
		t.Fatal("err = nil, want a failure naming the missing state file")
	}

	if !strings.Contains(err.Error(), "journalctl -u cockpitd") {
		t.Fatalf("err = %q, want it to point at the journal", err)
	}
}

func TestClaimRefusesToRenderAnExpiredCode(t *testing.T) {
	path := writeState(t, config.State{
		State:          config.StateAwaitingClaim,
		ClaimCode:      "4F2K-9TQX",
		ClaimExpiresAt: 1700000000,
	})

	out := &bytes.Buffer{}
	now := func() time.Time { return time.Unix(1700000060, 0) }

	// Printing it would send the operator to a form that rejects it.
	err := runClaim([]string{"--state", path}, out, now)
	if err == nil {
		t.Fatalf("err = nil, want a failure; output was %q", out)
	}

	if !strings.Contains(err.Error(), "no claim code is on offer") {
		t.Fatalf("err = %q, want it to refuse the dead code", err)
	}
}
