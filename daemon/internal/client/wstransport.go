package client

import (
	"context"
	"fmt"
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

// WSDialer dials the plane's /daemon endpoint over WSS.
func WSDialer(ctx context.Context, plane string) (Transport, error) {
	endpoint, err := DaemonURL(plane)
	if err != nil {
		return nil, err
	}

	conn, _, err := websocket.Dial(ctx, endpoint, nil)
	if err != nil {
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
