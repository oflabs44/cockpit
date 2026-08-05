package client_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/client"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

func welcomeConn(t *testing.T, serverID, credential string) *fakeTransport {
	t.Helper()

	return &fakeTransport{inbox: [][]byte{
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: serverID, Credential: credential}),
	}}
}

func TestFailedPersistIsRetriedNextSession(t *testing.T) {
	conns := []*fakeTransport{
		welcomeConn(t, "srv_1", "ck_cred_live"),
		welcomeConn(t, "srv_1", "ck_cred_live"),
	}

	var (
		dialed   int
		attempts int
	)

	c := newClient(t, nil)
	c.EnrolmentSecret = "ck_enrol_once"
	c.Backoff = client.Backoff{Base: time.Millisecond, Max: time.Second, Factor: 2}
	c.Dial = func(context.Context, string) (client.Transport, error) {
		i := dialed
		dialed++

		if i >= len(conns) {
			return nil, errors.New("no more connections")
		}

		return conns[i], nil
	}

	c.OnCredential = func(string, string) error {
		attempts++

		if attempts == 1 {
			return errors.New("disk full")
		}

		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c.Sleep = func(context.Context, time.Duration) error {
		if dialed >= len(conns) {
			cancel()

			return context.Canceled
		}

		return nil
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	if attempts != 2 {
		t.Fatalf("persist attempted %d times, want a retry after the failure", attempts)
	}

	// Nothing is burned until the credential is on disk.
	if c.EnrolmentSecret != "" {
		t.Fatal("enrolment secret still held after a successful persist")
	}

	// The failed persist must not have stopped the session: the box is useful
	// now, it is only a restart that would orphan it.
	frames := conns[0].frames()

	if len(frames) != 2 || frames[1]["type"] != protocol.TypeState {
		t.Fatalf("first session frames = %+v, want hello + state despite the failed persist", frames)
	}
}

func TestEnrolmentSecretSurvivesAFailedPersist(t *testing.T) {
	tr := welcomeConn(t, "srv_1", "ck_cred_live")

	c := newClient(t, tr)
	c.EnrolmentSecret = "ck_enrol_once"
	c.OnCredential = func(string, string) error { return errors.New("read-only filesystem") }

	runOnce(t, c)

	if c.EnrolmentSecret != "ck_enrol_once" {
		t.Fatal("enrolment secret burned before the credential reached disk")
	}

	if c.Credential != "ck_cred_live" {
		t.Fatalf("credential = %q, want the issued one held in memory", c.Credential)
	}
}

func TestServerIDLearnedWithoutACredentialIsPersisted(t *testing.T) {
	tr := welcomeConn(t, "srv_9", "")

	c := newClient(t, tr)
	c.Credential = "ck_cred_live"

	var got string
	c.OnCredential = func(serverID, _ string) error {
		got = serverID

		return nil
	}

	runOnce(t, c)

	if got != "srv_9" {
		t.Fatalf("persisted server_id %q, want srv_9", got)
	}
}

func TestServerIDMismatchIsRefused(t *testing.T) {
	tr := welcomeConn(t, "srv_other", "")

	c := newClient(t, tr)
	c.Credential = "ck_cred_live"
	c.ServerID = "srv_1"
	c.OnCredential = func(string, string) error {
		t.Fatal("persisted an identity the plane contradicted")

		return nil
	}

	runOnce(t, c)

	// The handshake failed, so nothing after hello went out.
	if frames := tr.frames(); len(frames) != 1 {
		t.Fatalf("frames = %+v, want hello only", frames)
	}

	if c.ServerID != "srv_1" {
		t.Fatalf("server_id = %q, want the original srv_1", c.ServerID)
	}
}
