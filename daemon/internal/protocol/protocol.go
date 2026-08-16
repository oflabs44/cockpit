// Package protocol defines the daemon <-> plane frame types.
//
// Field names and frame types are the contract from docs/type-design.md
// section 3 and must not be renamed here.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"
)

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

// LogStage is the deployment step a log chunk belongs to. The set is
// ADR-0012's deployment order — fetch -> normalize and validate -> build ->
// migrate -> compose up -> health — so a reader can group a deployment's
// output without parsing it.
type LogStage string

const (
	LogStageFetch     LogStage = "fetch"
	LogStageNormalize LogStage = "normalize"
	LogStageBuild     LogStage = "build"
	LogStageMigrate   LogStage = "migrate"
	LogStageApply     LogStage = "apply"
	LogStageHealth    LogStage = "health"
)

// IsLogStage reports whether s is a stage a deployment log may carry.
func IsLogStage(s LogStage) bool {
	switch s {
	case LogStageFetch, LogStageNormalize, LogStageBuild, LogStageMigrate, LogStageApply, LogStageHealth:
		return true
	default:
		return false
	}
}

// LogSource is where a chunk came from. `system` is the daemon's own narration
// ("running docker compose build"), which is neither of the child process's
// two streams and must not be mistaken for one.
type LogSource string

const (
	LogSourceStdout LogSource = "stdout"
	LogSourceStderr LogSource = "stderr"
	LogSourceSystem LogSource = "system"
)

// IsLogSource reports whether s is a source a deployment log may carry.
func IsLogSource(s LogSource) bool {
	switch s {
	case LogSourceStdout, LogSourceStderr, LogSourceSystem:
		return true
	default:
		return false
	}
}

// MaxLogChunkBytes bounds one chunk's Data. The daemon emits bounded fragments:
// an unbounded line (a build tool drawing a progress bar with no newline, a
// base64 blob) must not become one enormous frame. Longer output is split across
// chunks, which is why Seq and not line count is the ordering key.
//
// The limit is UTF-8 bytes, and Data must be valid UTF-8 for the two ends to be
// counting the same thing: the Plane measures the decoded string's UTF-8 length
// (apps/plane/src/schema.ts), while an invalid byte here is one byte to len()
// and three (U+FFFD) once JSON has encoded it. Chunks are made valid where they
// are produced, in daemon/internal/compose; Validate is where that is enforced.
const MaxLogChunkBytes = 8192

// StreamData is one chunk of a deployment's live output, daemon -> plane.
//
// StreamID is the Plane's Deployment id, and that identity is the contract, not
// a coincidence: the plane authorizes, looks up, and addresses the log's
// Durable Object by this one value. A separate deployment_id field would be a
// second copy of the same fact that could disagree with it, and the plane would
// then have to choose which half of a self-contradicting frame to trust.
//
// The contract is deliberately loss-aware. The transport is a WebSocket that
// reconnects, and the plane keeps a bounded replay tail, so a reader cannot
// assume it saw everything:
//
//   - Seq is monotonic per StreamID as the daemon produced it, so a consumer
//     detects reordering and loss rather than silently rendering a hole. It is
//     NOT a line number and does not restart per stage. It is gap-free only
//     while Dropped stays 0: a daemon that discards chunks skips their
//     sequences, so the jump and the count agree.
//   - Dropped counts chunks the daemon discarded before this one (backpressure,
//     a disconnected plane). Non-zero means output is missing at this point and
//     the reader should say so.
//   - Final marks the last chunk of the stream. It is the terminal signal the
//     plane needs to close and archive a log; without it a finished deployment
//     is indistinguishable from a stalled one.
//
// Secrets never travel here. The frame carries no environment map, no token,
// and no arbitrary metadata field — every field is a fixed scalar the plane
// projects onto a closed schema (apps/plane/src/schema.ts). Resolved
// environment values and GitHub installation tokens exist on the box only,
// immediately before Compose execution (ADR-0012), and a daemon that puts one
// in Data has leaked it into an operator-visible log by its own hand.
type StreamData struct {
	Type string `json:"type"`
	// The Plane Deployment id this output belongs to. See the note above.
	StreamID string    `json:"stream_id"`
	Seq      uint64    `json:"seq"`
	Stage    LogStage  `json:"stage"`
	Source   LogSource `json:"source"`
	Data     string    `json:"data"`
	At       int64     `json:"at"`
	Dropped  uint64    `json:"dropped,omitempty"`
	Final    bool      `json:"final,omitempty"`
}

// Validate reports why the frame is not a well-formed deployment log chunk, or
// nil when it is. The plane validates independently (a daemon is not trusted to
// have got this right); this exists so the daemon never emits a frame the plane
// will close its socket over.
func (s StreamData) Validate() error {
	switch {
	case s.Type != TypeStreamData:
		return fmt.Errorf("stream_data: type is %q", s.Type)
	case s.StreamID == "":
		return errors.New("stream_data: stream_id is empty")
	case !IsLogStage(s.Stage):
		return fmt.Errorf("stream_data: unknown stage %q", s.Stage)
	case !IsLogSource(s.Source):
		return fmt.Errorf("stream_data: unknown source %q", s.Source)
	case !utf8.ValidString(s.Data):
		// Checked before the length: an invalid byte triples in JSON, so the
		// count below only means what the Plane will measure once this holds.
		return errors.New("stream_data: data is not valid utf-8")
	case len(s.Data) > MaxLogChunkBytes:
		return fmt.Errorf("stream_data: data is %d bytes, over the %d limit", len(s.Data), MaxLogChunkBytes)
	case s.At <= 0:
		return errors.New("stream_data: at is not a timestamp")
	}

	return nil
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
