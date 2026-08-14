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

func TestUnwritableCredentialEndsTheDaemon(t *testing.T) {
	// The plane spends the enrolment secret in the same breath as issuing the
	// credential, so a daemon that carried on with one it could not write
	// would be a box whose identity lives in nothing but that process — and
	// every way of touching it afterwards, restart included, destroys the
	// server. Dying leaves a disk to fix and a fresh token to enrol with.
	tr := welcomeConn(t, "srv_1", "ck_cred_live")

	c := newClient(t, tr)
	c.EnrolmentSecret = "ck_enrol_once"
	c.OnCredential = func(string, string) error { return errors.New("read-only file system") }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c.Sleep = func(context.Context, time.Duration) error {
		t.Fatal("reconnected instead of exiting")

		return nil
	}

	err := c.Run(ctx)

	if !errors.Is(err, client.ErrCredentialNotPersisted) {
		t.Fatalf("Run err = %v, want ErrCredentialNotPersisted", err)
	}

	// And it did not go on to behave as though it were enrolled.
	frames := tr.frames()

	if len(frames) != 1 {
		t.Fatalf("frames = %+v, want hello only", frames)
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
