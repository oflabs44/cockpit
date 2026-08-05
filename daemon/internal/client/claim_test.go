package client_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/client"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// blockingTransport never answers, so the claim wait runs to its deadline.
type blockingTransport struct {
	fakeTransport
}

func (t *blockingTransport) Recv(ctx context.Context) ([]byte, error) {
	if b, err := t.fakeTransport.Recv(ctx); err == nil {
		return b, nil
	}

	<-ctx.Done()

	return nil, ctx.Err()
}

func TestUnclaimedHandshakePresentsCodeAndSendsNothingElse(t *testing.T) {
	tr := &blockingTransport{}
	out := &bytes.Buffer{}

	c := newClient(t, nil)
	c.Dial = func(context.Context, string) (client.Transport, error) { return tr, nil }
	c.NewClaimCode = func() (string, error) { return "4F2K-9TQX", nil }
	c.ClaimTTL = 20 * time.Millisecond
	c.Out = out

	// One wait, then stop: Sleep runs after the code expires.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c.Sleep = func(context.Context, time.Duration) error {
		cancel()

		return context.Canceled
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	frames := tr.frames()

	// An unenrolled connection may do nothing but enrol: hello, awaiting_claim,
	// and not one frame more — no state (type-design section 3.3).
	if len(frames) != 2 {
		t.Fatalf("sent %d frames, want hello + awaiting_claim only: %+v", len(frames), frames)
	}

	hello := frames[0]

	if hello["type"] != protocol.TypeHello {
		t.Fatalf("frame 0 = %v, want hello", hello["type"])
	}

	auth, _ := hello["auth"].(map[string]any)

	if auth["kind"] != protocol.AuthEnrolment || auth["secret"] != "4F2K-9TQX" {
		t.Fatalf("auth = %+v, want the claim code as an enrolment secret", auth)
	}

	awaiting := frames[1]

	if awaiting["type"] != protocol.TypeAwaitingClaim || awaiting["code"] != "4F2K-9TQX" {
		t.Fatalf("frame 1 = %+v, want awaiting_claim with the code", awaiting)
	}

	printed := out.String()

	for _, want := range []string{"4F2K-9TQX", "https://plane.test", "lab-nbg1", "Redeem the code"} {
		if !strings.Contains(printed, want) {
			t.Fatalf("operator output missing %q:\n%s", want, printed)
		}
	}
}

func TestClaimBindPersistsCredentialAndContinues(t *testing.T) {
	tr := &fakeTransport{inbox: [][]byte{
		mustJSON(t, protocol.Welcome{Type: protocol.TypeWelcome, ServerID: "srv_7", Credential: "ck_cred_live"}),
	}}

	out := &bytes.Buffer{}

	c := newClient(t, tr)
	c.NewClaimCode = func() (string, error) { return "4F2K-9TQX", nil }
	c.Out = out

	var gotServer, gotCred string
	c.OnCredential = func(serverID, credential string) error {
		gotServer, gotCred = serverID, credential

		return nil
	}

	runOnce(t, c)

	if gotServer != "srv_7" || gotCred != "ck_cred_live" {
		t.Fatalf("persisted (%q, %q), want (srv_7, ck_cred_live)", gotServer, gotCred)
	}

	frames := tr.frames()

	if len(frames) != 3 || frames[2]["type"] != protocol.TypeState {
		t.Fatalf("frames = %+v, want hello, awaiting_claim, state", frames)
	}
}

func TestClaimCodeIsRegeneratedOnExpiryAndReprinted(t *testing.T) {
	codes := []string{"AAAA-2222", "CCCC-3333", "DDDD-4444"}

	var (
		generated int
		conns     int
	)

	out := &bytes.Buffer{}

	c := newClient(t, nil)
	c.ClaimTTL = 10 * time.Millisecond
	c.Out = out
	c.Backoff = client.Backoff{Base: time.Millisecond, Max: time.Second, Factor: 2}
	c.NewClaimCode = func() (string, error) {
		code := codes[generated]
		generated++

		return code, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c.Dial = func(context.Context, string) (client.Transport, error) {
		conns++

		return &blockingTransport{}, nil
	}

	c.Sleep = func(context.Context, time.Duration) error {
		if conns >= 2 {
			cancel()

			return context.Canceled
		}

		return nil
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	if generated != 2 {
		t.Fatalf("generated %d codes across 2 expiries, want 2", generated)
	}

	printed := out.String()

	if !strings.Contains(printed, codes[0]) || !strings.Contains(printed, codes[1]) {
		t.Fatalf("both codes should have been printed:\n%s", printed)
	}
}

func TestClaimCodeExpiresOnWallClockNotPerSession(t *testing.T) {
	var (
		generated int
		dialed    int
		now       = time.Unix(0, 0)
	)

	c := newClient(t, nil)
	c.ClaimTTL = 10 * time.Minute
	c.Out = &bytes.Buffer{}
	c.Now = func() time.Time { return now }
	c.Backoff = client.Backoff{Base: time.Millisecond, Max: time.Second, Factor: 2}
	c.NewClaimCode = func() (string, error) {
		generated++

		return "AAAA-2222", nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Connections drop instantly, so no session ever reaches its own deadline.
	// Wall-clock time still passes between them.
	c.Dial = func(context.Context, string) (client.Transport, error) {
		dialed++

		return &fakeTransport{}, nil
	}

	c.Sleep = func(context.Context, time.Duration) error {
		now = now.Add(6 * time.Minute)

		if dialed >= 3 {
			cancel()

			return context.Canceled
		}

		return nil
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	// 0, +6min (still live), +12min (past the plane's 10 minutes): the third
	// session must not reprint a code the plane has already expired.
	if generated != 2 {
		t.Fatalf("generated %d codes over 12 simulated minutes, want 2", generated)
	}
}

func TestClaimCodeIsDroppedWhenThePlaneAnswersWithoutBinding(t *testing.T) {
	var (
		generated int
		dialed    int
	)

	c := newClient(t, nil)
	c.ClaimTTL = time.Hour // long, so only the rejection can drop the code
	c.Out = &bytes.Buffer{}
	c.Backoff = client.Backoff{Base: time.Millisecond, Max: time.Second, Factor: 2}
	c.NewClaimCode = func() (string, error) {
		generated++

		return "AAAA-2222", nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Each connection answers the claim with something that is not a welcome.
	c.Dial = func(context.Context, string) (client.Transport, error) {
		dialed++

		return &fakeTransport{inbox: [][]byte{mustJSON(t, map[string]any{"type": "ping"})}}, nil
	}

	c.Sleep = func(context.Context, time.Duration) error {
		if dialed >= 2 {
			cancel()

			return context.Canceled
		}

		return nil
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	// The plane spoke and did not bind us, so that code is spent even though it
	// has not aged out: the next wait generates a fresh one.
	if generated != dialed {
		t.Fatalf("generated %d codes across %d rejections, want one each", generated, dialed)
	}
}

func TestDroppedConnectionKeepsTheSameClaimCode(t *testing.T) {
	var (
		generated int
		dialed    int
	)

	out := &bytes.Buffer{}

	c := newClient(t, nil)
	c.ClaimTTL = time.Hour // long, so nothing expires during this test
	c.Out = out
	c.Backoff = client.Backoff{Base: time.Millisecond, Max: time.Second, Factor: 2}
	c.NewClaimCode = func() (string, error) {
		generated++

		return "AAAA-2222", nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Each connection dies immediately (EOF), as if the plane restarted.
	c.Dial = func(context.Context, string) (client.Transport, error) {
		dialed++

		return &fakeTransport{}, nil
	}

	c.Sleep = func(context.Context, time.Duration) error {
		if dialed >= 3 {
			cancel()

			return context.Canceled
		}

		return nil
	}

	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}

	// The operator is looking at a code on their screen; a dropped connection
	// must not invalidate it.
	if generated != 1 {
		t.Fatalf("generated %d codes, want 1 across %d dropped connections", generated, dialed)
	}

	if n := strings.Count(out.String(), "AAAA-2222"); n != dialed {
		t.Fatalf("printed the code %d times across %d connections, want one per connection", n, dialed)
	}
}
