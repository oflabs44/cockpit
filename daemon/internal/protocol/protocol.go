// Package protocol defines the daemon <-> plane frame types.
//
// Field names and frame types are the contract from docs/type-design.md
// section 3 and must not be renamed here.
package protocol

import "encoding/json"

// Frame type discriminators, daemon -> plane (Up).
const (
	TypeHello         = "hello"
	TypeAwaitingClaim = "awaiting_claim"
	TypeState         = "state"
	TypeEvent         = "event"
	TypeTaskProgress  = "task_progress"
	TypeStreamData    = "stream_data"
	TypeMetrics       = "metrics"
	TypePong          = "pong"
)

// Frame type discriminators, plane -> daemon (Down).
const (
	TypeTask    = "task"
	TypeOp      = "op"
	TypeStream  = "stream"
	TypeProbe   = "probe"
	TypeExec    = "exec"
	TypePing    = "ping"
	TypeWelcome = "welcome"
)

// Auth kinds carried by Hello.Auth.
const (
	AuthEnrolment  = "enrolment"
	AuthCredential = "credential"
)

// Health values (type-design section 1).
type Health string

const (
	HealthHealthy   Health = "healthy"
	HealthDegraded  Health = "degraded"
	HealthUnhealthy Health = "unhealthy"
	HealthStopped   Health = "stopped"
	HealthUnknown   Health = "unknown"
)

// serverKinds is the closed set of server-scoped kinds from type-design
// section 2.2. Anything the daemon reports must be one of them.
var serverKinds = map[string]bool{
	"app": true, "database": true, "proxy": true, "volume": true,
	"network": true, "cron": true, "daemon": true, "firewall_rule": true,
}

// IsServerKind reports whether s is a kind a daemon may report.
func IsServerKind(s string) bool {
	return serverKinds[s]
}

// Auth is the credential presented in a Hello frame. On first contact the
// secret is an enrolment token; thereafter the long-lived per-server
// credential.
type Auth struct {
	Kind   string `json:"kind"`
	Secret string `json:"secret"`
}

// Hello is the first frame on every connection.
type Hello struct {
	Type         string `json:"type"`
	AgentVersion string `json:"agent_version"`
	Arch         string `json:"arch"`
	Hostname     string `json:"hostname"`
	Auth         Auth   `json:"auth"`
	ServerID     string `json:"server_id,omitempty"`
}

// AwaitingClaim identifies an unbound daemon by the code it printed for the
// operator, sent immediately after hello in the claim-code flow.
type AwaitingClaim struct {
	Type string `json:"type"`
	Code string `json:"code"`
}

// Observed is what the daemon actually found for one resource.
type Observed struct {
	Exists     bool           `json:"exists"`
	Health     Health         `json:"health"`
	Detail     map[string]any `json:"detail"`
	ObservedAt int64          `json:"observed_at"`
}

// ObservedResource is one entry of a state snapshot.
type ObservedResource struct {
	Kind     string   `json:"kind"`
	Name     string   `json:"name"`
	Observed Observed `json:"observed"`
}

// State is a full snapshot, sent on connect and on an interval.
type State struct {
	Type      string             `json:"type"`
	Rev       int                `json:"rev"`
	Resources []ObservedResource `json:"resources"`
}

// Pong answers a Ping.
type Pong struct {
	Type string `json:"type"`
}

// Welcome is the plane's answer to a Hello. Not specified in type-design
// section 3.2; see the enrolment note in daemon/README.md. Credential is set
// only when the Hello presented an enrolment secret.
type Welcome struct {
	Type       string `json:"type"`
	ServerID   string `json:"server_id"`
	Credential string `json:"credential,omitempty"`
}

// Down is a partially decoded plane -> daemon frame. Only the discriminator is
// interpreted in this slice; the rest is retained verbatim.
type Down struct {
	Type string          `json:"type"`
	Raw  json.RawMessage `json:"-"`
}

// DecodeDown reads the discriminator off a raw plane frame.
func DecodeDown(b []byte) (Down, error) {
	var d struct {
		Type string `json:"type"`
	}

	if err := json.Unmarshal(b, &d); err != nil {
		return Down{}, err
	}

	return Down{Type: d.Type, Raw: append(json.RawMessage(nil), b...)}, nil
}
