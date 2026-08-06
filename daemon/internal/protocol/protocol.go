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
	TypeOpResult      = "op_result"
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

// HostIdentity is what the box calls itself.
type HostIdentity struct {
	OS       string `json:"os"` // PRETTY_NAME from /etc/os-release
	Kernel   string `json:"kernel"`
	Hostname string `json:"hostname"`
	UptimeS  int64  `json:"uptime_s"`
}

// Disk is one mounted filesystem, in bytes.
type Disk struct {
	Mount string `json:"mount"`
	Size  int64  `json:"size"`
	Used  int64  `json:"used"`
}

// HostCapacity is what the box has, in bytes and counts. No percentages and no
// thresholds: what counts as full is plane policy.
type HostCapacity struct {
	CPUs      int    `json:"cpus"`
	MemTotal  int64  `json:"mem_total"`
	SwapTotal int64  `json:"swap_total"`
	Disks     []Disk `json:"disks"`
}

// Listener is one listening socket.
type Listener struct {
	Proto   string `json:"proto"`
	Addr    string `json:"addr"`
	Port    int    `json:"port"`
	PIDName string `json:"pid_name"`
}

// SSHD is the effective sshd configuration, as sshd itself reports it.
type SSHD struct {
	PermitRootLogin        string `json:"permit_root_login"`
	PasswordAuthentication string `json:"password_authentication"`
	MaxAuthTries           int    `json:"max_auth_tries"`
}

// HostSecurity is the security baseline, reported raw. Whether "yes" on root
// login is a red line is the plane's call.
type HostSecurity struct {
	SSHD                     SSHD  `json:"sshd"`
	Fail2banActive           bool  `json:"fail2ban_active"`
	UnattendedUpgradesActive bool  `json:"unattended_upgrades_active"`
	LastAptActivityUnix      int64 `json:"last_apt_activity_unix"`
}

// ObservedHost is the host-level half of a state snapshot: identity, capacity,
// load, listeners, and the security baseline. Facts only.
type ObservedHost struct {
	Identity  HostIdentity `json:"identity"`
	Capacity  HostCapacity `json:"capacity"`
	Load      [3]float64   `json:"load"`
	Listeners []Listener   `json:"listeners"`
	Security  HostSecurity `json:"security"`
}

// Probe outcomes. A probe that ran and found nothing is ok; one whose command
// is missing or failed is unavailable, so the plane reads that kind's absence
// as unknown rather than as every resource having been deleted.
const (
	ProbeOK          = "ok"
	ProbeUnavailable = "unavailable"
)

// State is a full snapshot, sent on connect and on an interval.
type State struct {
	Type      string             `json:"type"`
	Rev       int                `json:"rev"`
	Resources []ObservedResource `json:"resources"`
	Host      *ObservedHost      `json:"host,omitempty"`
	Probes    map[string]string  `json:"probes,omitempty"`
}

// Changed is the result of any ensure-semantics op (type-design section 1).
const (
	ChangedCreate  = "create"
	ChangedInPlace = "in_place"
	ChangedReplace = "replace"
	ChangedNoOp    = "no_op"
)

// Ops the daemon implements. Anything else in the Op union belongs to the
// plane or to a later slice and is refused rather than guessed at.
const (
	OpResourceCreate  = "resource.create"
	OpResourceUpdate  = "resource.update"
	OpResourceDelete  = "resource.delete"
	OpResourceStart   = "resource.start"
	OpResourceStop    = "resource.stop"
	OpResourceRestart = "resource.restart"
)

// Change is one entry of a plan, as the daemon needs it. The plane's Change
// carries more (inverse, status, error); those are its bookkeeping.
type Change struct {
	Op     string  `json:"op"`
	Target string  `json:"target"`
	Before *Target `json:"before"`
	After  *Target `json:"after"`
	Impact string  `json:"impact"`
}

// Target is the resource a change acts on. `Change.target` is a plane-side
// resource id, and the daemon holds no plane ids (#13), so the kind and name
// it addresses the box by have to travel in the payload.
type Target struct {
	Kind string  `json:"kind"`
	Name string  `json:"name"`
	Spec AppSpec `json:"spec"`
}

// Port is one published port.
type Port struct {
	Container int    `json:"container"`
	Host      int    `json:"host"`
	Protocol  string `json:"protocol"`
}

// Limits bound a container's resources.
type Limits struct {
	CPU    string `json:"cpu"`
	Memory string `json:"memory"`
}

// AppSpec is the daemon's slice of the app kind: what it takes to run the
// container. Env values arrive already resolved — the daemon does not
// dereference secret refs in this slice (ADR-0008 resolution is its own).
type AppSpec struct {
	Image   string            `json:"image"`
	Ports   []Port            `json:"ports"`
	Env     map[string]string `json:"env"`
	Labels  map[string]string `json:"labels"`
	Restart string            `json:"restart"`
	Limits  Limits            `json:"limits"`
}

// Task is a plane -> daemon frame carrying a plan's changes.
type Task struct {
	Type    string   `json:"type"`
	TaskID  string   `json:"task_id"`
	PlanID  string   `json:"plan_id"`
	Changes []Change `json:"changes"`
}

// Op is a plane -> daemon frame carrying one direct operation. It may never
// carry a spec change: that restriction is what keeps the carve-out from
// being a loophole (type-design section 3.3).
type Op struct {
	Type       string `json:"type"`
	OpID       string `json:"op_id"`
	EventID    string `json:"event_id"`
	Action     string `json:"action"`
	ResourceID string `json:"resource_id"`
	// Kind and Name are the daemon's only way to find the container: it holds
	// no plane resource ids. See the protocol note in daemon/README.md.
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// TaskProgress reports one change's outcome.
type TaskProgress struct {
	Type        string      `json:"type"`
	TaskID      string      `json:"task_id"`
	ChangeIndex int         `json:"change_index"`
	Status      string      `json:"status"`
	Changed     string      `json:"changed,omitempty"`
	Error       *FrameError `json:"error,omitempty"`
}

// TaskProgress statuses.
const (
	ProgressStarted = "started"
	ProgressOK      = "ok"
	ProgressError   = "error"
)

// OpResult is the outcome of a direct op: success, failure, or refusal.
// Without it a failed restart is indistinguishable plane-side from a
// successful no_op, and a refused frame from a dead daemon.
type OpResult struct {
	Type    string      `json:"type"`
	OpID    string      `json:"op_id"`
	Changed string      `json:"changed,omitempty"`
	Error   *FrameError `json:"error,omitempty"`
}

// ErrRefused is the error kind for a frame the daemon declined to execute, as
// opposed to one it tried and failed.
const ErrRefused = "refused"

// FrameError is a typed error as the protocol carries it.
type FrameError struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
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
