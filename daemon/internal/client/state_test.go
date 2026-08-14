package client_test

import (
	"context"
	"errors"
	"io"
	"path/filepath"
	"testing"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/client"
	"github.com/oflabs44/cockpit/daemon/internal/config"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// statePath wires a client to a real state file, since what `cockpitd claim`
// later reads is the file rather than the call.
func statePath(t *testing.T, c *client.Client) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "state.json")
	c.PublishState = func(s config.State) error { return config.SaveState(path, s) }

	return path
}

func TestPublishesAwaitingClaimWithTheCodeOnScreen(t *testing.T) {
	// An empty inbox EOFs on the first Recv, which ends the session with the
	// code still inside its life — the case where awaiting_claim must stand.
	tr := &fakeTransport{}

	c := newClient(t, nil)
	c.Dial = func(context.Context, string, string) (client.Transport, error) { return tr, nil }
	c.NewClaimCode = func() (string, error) { return "4F2K-9TQX", nil }
	c.ClaimTTL = 20 * time.Millisecond
	c.Now = func() time.Time { return time.Unix(1700000000, 0) }
	c.Out = io.Discard

	path := statePath(t, c)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Read while the daemon is between sessions, which is what an operator
	// looking at the file sees. What it says once the process has stopped is a
	// different question, and a different test.
	var got config.State

	c.Sleep = func(context.Context, time.Duration) error {
		got, _ = config.LoadState(path)
		cancel()

		return context.Canceled
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	want := config.State{
		State:          config.StateAwaitingClaim,
		ClaimCode:      "4F2K-9TQX",
		ClaimExpiresAt: time.Unix(1700000000, 0).Add(20 * time.Millisecond).Unix(),
		Plane:          "https://plane.test",
		Hostname:       "lab-nbg1",
	}

	if got != want {
		t.Fatalf("state = %+v, want %+v", got, want)
	}
}

func TestBindOverwritesTheAwaitingClaimState(t *testing.T) {
	// One session that prints a code and is then bound: everything published
	// after the welcome must describe the bind, not the code the operator was
	// looking at a moment earlier.
	tr := &fakeTransport{inbox: [][]byte{
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1", Credential: "ck_cred_live"}),
	}}

	c := newClient(t, tr)
	c.NewClaimCode = func() (string, error) { return "4F2K-9TQX", nil }
	c.Out = io.Discard
	c.OnCredential = func(string, string) error { return nil }

	var published []config.State

	c.PublishState = func(s config.State) error {
		published = append(published, s)

		return nil
	}

	runOnce(t, c)

	if len(published) < 2 {
		t.Fatalf("published %+v, want at least awaiting_claim then connected", published)
	}

	if published[0].State != config.StateAwaitingClaim || published[0].ClaimCode != "4F2K-9TQX" {
		t.Fatalf("first = %+v, want awaiting_claim with the code", published[0])
	}

	bound := published[1]

	if bound.State != config.StateConnected || bound.ServerID != "srv_1" {
		t.Fatalf("second = %+v, want connected as srv_1", bound)
	}

	if bound.ClaimCode != "" || bound.ClaimExpiresAt != 0 {
		t.Fatalf("second = %+v, want the claim code gone", bound)
	}

	// And nothing after the bind may bring the code back.
	for _, s := range published[1:] {
		if s.ClaimCode != "" {
			t.Fatalf("published %+v after the bind, want no claim code", s)
		}
	}
}

func TestBoundDaemonPublishesDisconnectedWhenTheSessionEnds(t *testing.T) {
	// The transport hands over one welcome and then EOFs, which is what a
	// dropped socket looks like from here.
	tr := &fakeTransport{inbox: [][]byte{
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1"}),
	}}

	c := newClient(t, tr)
	c.Credential = "ck_cred_live"
	c.SnapshotInterval = 0

	path := statePath(t, c)

	runOnce(t, c)

	got, err := config.LoadState(path)
	if err != nil {
		t.Fatal(err)
	}

	// Not `connected`: the daemon is backing off, and a file that says
	// otherwise is worse than no file.
	if got.State != config.StateDisconnected || got.ServerID != "srv_1" {
		t.Fatalf("state = %+v, want disconnected as srv_1", got)
	}
}

func TestUnboundDaemonKeepsTheClaimCodeAcrossADroppedSession(t *testing.T) {
	// The socket drops (EOF) while the printed code is still well inside its
	// ten minutes.
	tr := &fakeTransport{}

	c := newClient(t, nil)
	c.Dial = func(context.Context, string, string) (client.Transport, error) { return tr, nil }
	c.NewClaimCode = func() (string, error) { return "4F2K-9TQX", nil }
	c.Out = io.Discard

	path := statePath(t, c)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// The backoff is exactly the window this test is about: the session has
	// dropped, the daemon has not.
	var duringBackoff config.State

	c.Sleep = func(context.Context, time.Duration) error {
		duringBackoff, _ = config.LoadState(path)
		cancel()

		return context.Canceled
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	// The code on the operator's screen is retired by its own deadline and by
	// nothing else, so a session that merely ended must not take it off the box.
	if duringBackoff.State != config.StateAwaitingClaim || duringBackoff.ClaimCode != "4F2K-9TQX" {
		t.Fatalf("state = %+v, want the claim code still standing", duringBackoff)
	}
}

func TestUnboundDaemonThatNeverReachedThePlanePublishesDisconnected(t *testing.T) {
	// The install-day failure: wrong plane URL, blocked egress, a token the
	// plane refused. The code this daemon generated was never presented, so
	// nobody can redeem it and silence here would read as "failed to start".
	c := newClient(t, nil)
	c.Dial = func(context.Context, string, string) (client.Transport, error) {
		return nil, errors.New("dial tcp: connection refused")
	}
	c.NewClaimCode = func() (string, error) { return "4F2K-9TQX", nil }
	c.Out = io.Discard

	path := statePath(t, c)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c.Sleep = func(context.Context, time.Duration) error {
		cancel()

		return context.Canceled
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	got, err := config.LoadState(path)
	if err != nil {
		t.Fatal(err)
	}

	if got.State != config.StateDisconnected {
		t.Fatalf("state = %+v, want disconnected", got)
	}

	// No server_id is what tells an unbound daemon apart from a bound one that
	// lost its connection, and no code, because the plane never saw one.
	if got.ServerID != "" || got.ClaimCode != "" {
		t.Fatalf("state = %+v, want no server id and no claim code", got)
	}
}

func TestServerIDWithoutACredentialIsStillTheClaimFlow(t *testing.T) {
	// A hand-edited or half-restored config: server_id present, credential
	// gone. claiming() calls that unbound, so everything else must too —
	// otherwise the code on offer gets overwritten by a `disconnected` that
	// also advertises a server id, and `cockpitd claim` reports a box as bound
	// while its own code is live on screen.
	tr := &fakeTransport{}

	c := newClient(t, nil)
	c.ServerID = "srv_1"
	c.Dial = func(context.Context, string, string) (client.Transport, error) { return tr, nil }
	c.NewClaimCode = func() (string, error) { return "4F2K-9TQX", nil }
	c.Out = io.Discard

	path := statePath(t, c)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var duringBackoff config.State

	c.Sleep = func(context.Context, time.Duration) error {
		duringBackoff, _ = config.LoadState(path)
		cancel()

		return context.Canceled
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	if duringBackoff.State != config.StateAwaitingClaim || duringBackoff.ClaimCode != "4F2K-9TQX" {
		t.Fatalf("state = %+v, want the claim code still standing", duringBackoff)
	}

	if duringBackoff.ServerID != "" {
		t.Fatalf("state = %+v, want no server id: a claiming daemon is not bound", duringBackoff)
	}

	// And the same on the way out, where a server_id would make `status` call
	// an unbound box orphaned.
	stopped, err := config.LoadState(path)
	if err != nil {
		t.Fatal(err)
	}

	if stopped.ServerID != "" {
		t.Fatalf("state = %+v, want no server id after shutdown either", stopped)
	}
}

func TestShutdownPublishesDisconnected(t *testing.T) {
	// RuntimeDirectory= takes the file away with the unit on a packaged
	// install, but --foreground as root writes the same path with nothing to
	// clean it up. A stopped daemon that goes on saying `connected` is a lie
	// that outlives the process.
	tr := &fakeTransport{inbox: [][]byte{
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1"}),
	}}

	c := newClient(t, tr)
	c.Credential = "ck_cred_live"

	path := statePath(t, c)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Stop the daemon the way a signal does, between sessions.
	c.Sleep = func(context.Context, time.Duration) error {
		cancel()

		return context.Canceled
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	got, err := config.LoadState(path)
	if err != nil {
		t.Fatal(err)
	}

	if got.State != config.StateDisconnected {
		t.Fatalf("state = %+v, want disconnected after shutdown", got)
	}
}

func TestPublishFailureDoesNotEndTheSession(t *testing.T) {
	tr := &fakeTransport{inbox: [][]byte{
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_1"}),
	}}

	c := newClient(t, tr)
	c.Credential = "ck_cred_live"
	c.PublishState = func(config.State) error { return errors.New("read-only filesystem") }

	runOnce(t, c)

	// The state file describes the daemon; it is not how the daemon works, so a
	// failed write must not cost the plane its snapshot.
	frames := tr.frames()

	if len(frames) != 2 || frames[1]["type"] != protocol.TypeState {
		t.Fatalf("frames = %+v, want hello + state", frames)
	}
}
