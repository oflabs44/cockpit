package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/config"
)

func TestStatusOf(t *testing.T) {
	now := time.Unix(1700000000, 0)
	live := config.State{State: config.StateAwaitingClaim, ClaimCode: "4F2K-9TQX", ClaimExpiresAt: 1700000600}
	dead := config.State{State: config.StateAwaitingClaim, ClaimCode: "4F2K-9TQX", ClaimExpiresAt: 1699999999}

	tests := []struct {
		name      string
		cfg       config.File
		state     config.State
		published bool

		disposition string
		enrolled    bool
	}{
		{
			name:        "fresh box",
			disposition: DispositionNotEnrolled,
		},
		{
			name:        "enrolled but the daemon is saying nothing",
			cfg:         config.File{Credential: "ck_cred_live", ServerID: "srv_1"},
			disposition: DispositionUnknown,
			enrolled:    true,
		},
		{
			name:        "a live code is on offer",
			state:       live,
			published:   true,
			disposition: DispositionAwaitingClaim,
		},
		{
			// An expired published code is not awaiting_claim: `claim` refuses
			// to print it, so `status` must not call it live either, or
			// install.sh ends up waiting for a state that means nothing.
			name:        "the published code has expired",
			state:       dead,
			published:   true,
			disposition: DispositionNotEnrolled,
		},
		{
			name:        "enrolled and connected",
			cfg:         config.File{Credential: "ck_cred_live", ServerID: "srv_1"},
			state:       config.State{State: config.StateConnected, ServerID: "srv_1"},
			published:   true,
			disposition: DispositionConnected,
			enrolled:    true,
		},
		{
			name:        "enrolled and unreachable",
			cfg:         config.File{Credential: "ck_cred_live", ServerID: "srv_1"},
			state:       config.State{State: config.StateDisconnected, ServerID: "srv_1"},
			published:   true,
			disposition: DispositionDisconnected,
			enrolled:    true,
		},
		{
			// A rejected token lands here. Reporting not_enrolled would tell
			// the operator to enrol the server, which is what they just did.
			name:        "not enrolled and not reaching the plane",
			state:       config.State{State: config.StateDisconnected},
			published:   true,
			disposition: DispositionDisconnected,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := statusOf(tc.cfg, tc.state, tc.published, now)

			if got.Disposition != tc.disposition {
				t.Errorf("disposition = %q, want %q", got.Disposition, tc.disposition)
			}

			if got.Enrolled != tc.enrolled {
				t.Errorf("enrolled = %v, want %v", got.Enrolled, tc.enrolled)
			}

			if got.Advice == "" {
				t.Error("advice is empty: every disposition owes a human a next step")
			}
		})
	}
}

func TestRejectedTokenAdviceNamesTheToken(t *testing.T) {
	// The daemon holds a token, the plane refused it, so it publishes
	// disconnected while holding no credential. The generic "cannot reach the
	// plane" line would send the operator to check egress on a box whose
	// networking is fine.
	s := statusOf(
		config.File{Plane: "https://plane.test"},
		config.State{State: config.StateDisconnected, Hostname: "lab-nbg1"},
		true,
		time.Unix(1700000000, 0),
	)

	if !strings.Contains(s.Advice, "token") {
		t.Fatalf("advice = %q, want it to name the enrolment token", s.Advice)
	}
}

func TestStatusAndClaimAgreeAboutALiveCode(t *testing.T) {
	// One expiry test, asked by both, so `status` cannot report a code as
	// claimable that `claim` then refuses to print.
	dead := config.State{
		State:          config.StateAwaitingClaim,
		ClaimCode:      "4F2K-9TQX",
		ClaimExpiresAt: 1700000000,
		Hostname:       "lab-nbg1",
	}

	path := writeState(t, dead)
	now := func() time.Time { return time.Unix(1700000060, 0) }

	if got := statusOf(config.File{}, dead, true, now()); got.Disposition == DispositionAwaitingClaim {
		t.Fatalf("status = %+v, want an expired code not to read as awaiting_claim", got)
	}

	if err := runClaim([]string{"--state", path}, &bytes.Buffer{}, now); err == nil {
		t.Fatal("claim rendered an expired code")
	}
}

func TestStatusJSONIsMachineReadable(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.json")
	statePath := filepath.Join(dir, "state.json")

	if err := config.Save(cfgPath, config.File{Plane: "https://plane.test", ServerID: "srv_1", Credential: "ck_cred_live"}); err != nil {
		t.Fatal(err)
	}

	if err := config.SaveState(statePath, config.State{
		State:    config.StateConnected,
		ServerID: "srv_1",
		Hostname: "lab-nbg1",
	}); err != nil {
		t.Fatal(err)
	}

	out := &bytes.Buffer{}

	if err := runStatus([]string{"--json", "--config", cfgPath, "--state", statePath}, out, time.Now); err != nil {
		t.Fatal(err)
	}

	var got Status

	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out)
	}

	if got.Disposition != DispositionConnected || !got.Enrolled || got.ServerID != "srv_1" {
		t.Fatalf("status = %+v, want connected as srv_1", got)
	}
}

func TestStatusOnAFreshBoxIsNotAnError(t *testing.T) {
	// install.sh reads this before anything exists, under `set -e`. A failure
	// here would abort the install it is trying to plan.
	dir := t.TempDir()

	out := &bytes.Buffer{}
	args := []string{
		"--json",
		"--config", filepath.Join(dir, "config.json"),
		"--state", filepath.Join(dir, "state.json"),
	}

	if err := runStatus(args, out, time.Now); err != nil {
		t.Fatal(err)
	}

	var got Status

	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}

	if got.Disposition != DispositionNotEnrolled || got.Enrolled {
		t.Fatalf("status = %+v, want not_enrolled", got)
	}
}
