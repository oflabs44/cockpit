package client_test

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	ws "github.com/coder/websocket"
	"github.com/oflabs44/cockpit/daemon/internal/client"
)

// dialSecrets runs one session and returns the secret the dialer was given.
func dialSecret(t *testing.T, prepare func(*client.Client)) string {
	t.Helper()

	var got string

	c := newClient(t, nil)
	c.Out = &bytes.Buffer{}
	c.Dial = func(_ context.Context, _, secret string) (client.Transport, error) {
		got = secret

		return nil, errors.New("stop here")
	}

	prepare(c)
	runOnce(t, c)

	return got
}

func TestDialPresentsTheSecretForEachAuthMode(t *testing.T) {
	credential := dialSecret(t, func(c *client.Client) { c.Credential = "ck_cred_live" })

	if credential != "ck_cred_live" {
		t.Fatalf("enrolled daemon dialled with %q, want the credential", credential)
	}

	token := dialSecret(t, func(c *client.Client) { c.EnrolmentSecret = "ck_enrol_8fkq2t" })

	if token != "ck_enrol_8fkq2t" {
		t.Fatalf("enrolling daemon dialled with %q, want the token", token)
	}

	code := dialSecret(t, func(c *client.Client) {
		c.NewClaimCode = func() (string, error) { return "AAAA-2222", nil }
	})

	// Unprefixed: the plane reads anything without ck_ as a claim code, and the
	// daemon never adds a prefix of its own.
	if code != "AAAA-2222" {
		t.Fatalf("claiming daemon dialled with %q, want the claim code", code)
	}
}

func TestWSDialerSendsBearerHeader(t *testing.T) {
	var got string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")

		conn, err := ws.Accept(w, r, nil)
		if err != nil {
			return
		}

		conn.Close(ws.StatusNormalClosure, "")
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	tr, err := client.WSDialer(ctx, srv.URL, "ck_cred_live")
	if err != nil {
		t.Fatal(err)
	}

	tr.Close()

	if got != "Bearer ck_cred_live" {
		t.Fatalf("Authorization = %q, want Bearer ck_cred_live", got)
	}
}

func TestWSDialerReportsRejectionStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := client.WSDialer(context.Background(), srv.URL, "AAAA-2222")

	var se *client.StatusError

	if !errors.As(err, &se) || se.Status != http.StatusTooManyRequests {
		t.Fatalf("err = %v, want a StatusError carrying 429", err)
	}
}

func TestConflictOnDialKeepsTheClaimCode(t *testing.T) {
	var (
		generated int
		dialed    int
	)

	c := newClient(t, nil)
	c.ClaimTTL = time.Hour
	c.Out = &bytes.Buffer{}
	c.Backoff = client.Backoff{Base: time.Millisecond, Max: time.Second, Factor: 2}
	c.NewClaimCode = func() (string, error) {
		generated++

		return "AAAA-2222", nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 409: another socket already holds this claim. The operator is looking at
	// the code, and the plane is waiting on it — regenerating would strand both.
	c.Dial = func(context.Context, string, string) (client.Transport, error) {
		dialed++

		return nil, &client.StatusError{Status: http.StatusConflict, Err: errors.New("pending")}
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

	if generated != 1 {
		t.Fatalf("generated %d codes across %d conflicts, want 1", generated, dialed)
	}
}

// closingTransport answers the claim wait with a close code.
type closingTransport struct {
	fakeTransport
	code ws.StatusCode
}

func (t *closingTransport) Recv(context.Context) ([]byte, error) {
	return nil, ws.CloseError{Code: t.code, Reason: "plane closed"}
}

func TestClaimExpiredCloseRegeneratesTheCode(t *testing.T) {
	var (
		generated int
		dialed    int
	)

	out := &bytes.Buffer{}

	c := newClient(t, nil)
	c.ClaimTTL = time.Hour // only the close code can drop it
	c.Out = out
	c.Backoff = client.Backoff{Base: time.Millisecond, Max: time.Second, Factor: 2}
	c.NewClaimCode = func() (string, error) {
		generated++

		return []string{"AAAA-2222", "CCCC-3333"}[generated-1], nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c.Dial = func(context.Context, string, string) (client.Transport, error) {
		dialed++

		return &closingTransport{code: 4007}, nil
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

	if generated != 2 {
		t.Fatalf("generated %d codes across %d expiry closes, want one each", generated, dialed)
	}

	if printed := out.String(); !bytes.Contains([]byte(printed), []byte("CCCC-3333")) {
		t.Fatalf("the regenerated code was never printed:\n%s", printed)
	}
}

func TestTokenRaceCloseKeepsTheToken(t *testing.T) {
	tr := &closingTransport{code: 4006}

	c := newClient(t, nil)
	c.EnrolmentSecret = "ck_enrol_8fkq2t"
	c.Dial = func(context.Context, string, string) (client.Transport, error) { return tr, nil }

	runOnce(t, c)

	// The plane picks the winner; this daemon retries with the same token.
	if c.EnrolmentSecret != "ck_enrol_8fkq2t" {
		t.Fatalf("token = %q, want it retained after losing the race", c.EnrolmentSecret)
	}
}
