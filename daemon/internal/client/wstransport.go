package client

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/coder/websocket"
)

const maxFrameBytes = 8 << 20

// wsTransport is a Transport over one WebSocket connection.
type wsTransport struct {
	conn *websocket.Conn
}

func (t *wsTransport) Send(ctx context.Context, b []byte) error {
	return t.conn.Write(ctx, websocket.MessageText, b)
}

func (t *wsTransport) Recv(ctx context.Context) ([]byte, error) {
	_, b, err := t.conn.Read(ctx)

	return b, err
}

func (t *wsTransport) Close() error {
	return t.conn.Close(websocket.StatusNormalClosure, "")
}

// StatusError carries the HTTP status of a rejected upgrade, so the reconnect
// loop can say why rather than logging a bare dial failure.
type StatusError struct {
	Status int
	Err    error
}

func (e *StatusError) Error() string { return e.Err.Error() }
func (e *StatusError) Unwrap() error { return e.Err }

// CloseCode is the WebSocket close code behind err, or -1.
func CloseCode(err error) int {
	return int(websocket.CloseStatus(err))
}

// WSDialer dials the plane's /daemon endpoint over WSS, presenting the secret
// in the upgrade request: the plane resolves which server (or claim) this is
// before it picks a Durable Object.
func WSDialer(ctx context.Context, plane, secret string) (Transport, error) {
	endpoint, err := DaemonURL(plane)
	if err != nil {
		return nil, err
	}

	conn, resp, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + secret}},
	})

	if err != nil {
		if resp != nil {
			return nil, &StatusError{Status: resp.StatusCode, Err: err}
		}

		return nil, err
	}

	conn.SetReadLimit(maxFrameBytes)

	return &wsTransport{conn: conn}, nil
}

// DaemonURL turns a plane base URL into its /daemon WebSocket endpoint. http
// and https are accepted and mapped to ws and wss, so --plane takes the same
// URL the operator pastes into a browser.
func DaemonURL(plane string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(plane))
	if err != nil {
		return "", fmt.Errorf("parse plane url: %w", err)
	}

	switch u.Scheme {
	case "https", "wss":
		u.Scheme = "wss"
	case "http", "ws":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("plane url scheme %q is not http(s) or ws(s)", u.Scheme)
	}

	if u.Host == "" {
		return "", fmt.Errorf("plane url has no host: %q", plane)
	}

	u.Path = strings.TrimSuffix(u.Path, "/") + "/daemon"
	u.RawQuery = ""
	u.Fragment = ""

	return u.String(), nil
}
