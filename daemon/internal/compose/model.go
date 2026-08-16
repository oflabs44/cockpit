package compose

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
)

// Model is the effective Compose document for one project, as `docker compose
// config` resolved it. It is deliberately partial: it carries what deployment
// and policy need, and Raw carries everything else. Re-modelling the whole
// Compose spec here would mean maintaining a second, worse implementation of a
// specification Docker already owns.
type Model struct {
	Name     string
	Services map[string]Service
	Networks map[string]Network
	Volumes  map[string]Volume
	Configs  map[string]FileSource
	Secrets  map[string]FileSource

	// Raw is the normalized document exactly as Docker emitted it. It is what
	// a Release snapshots; the structured fields are for deciding, not storing.
	Raw []byte
}

// ServiceNames returns the service keys in sorted order, so callers and error
// messages are deterministic.
func (m *Model) ServiceNames() []string {
	return slices.Sorted(maps.Keys(m.Services))
}

// Service is one Compose service. The fields below the divider exist only
// because the policy rejects them; they are kept verbatim so an error can
// quote what the repository actually asked for.
type Service struct {
	Name        string
	Image       string
	Build       *Build
	Command     []string
	Entrypoint  []string
	Environment map[string]string
	// EnvFiles are the service's `env_file` paths as the repository wrote
	// them. Their contents are deliberately not resolved into Environment;
	// only the references are carried, so policy can check where they point.
	EnvFiles    []string
	Healthcheck *Healthcheck
	Networks    []string
	Mounts      []Mount
	DependsOn   []string
	Profiles    []string
	Restart     string
	Limits      *Limits

	Privileged        bool
	ContainerName     string
	PID               string
	IPC               string
	UTS               string
	NetworkMode       string
	UsernsMode        string
	Cgroup            string
	CgroupParent      string
	Devices           []string
	DeviceCgroupRules []string
	CapAdd            []string
	SecurityOpt       []string
	VolumesFrom       []string
	Ports             []Port
}

// Build is the build stanza of a buildable service. A service with a Build is
// built on the box before apply and receives a release image name.
type Build struct {
	Context    string
	Dockerfile string
	Target     string
	Args       map[string]string
}

// Healthcheck records whether a service declares one and what it runs. The
// timing fields are Docker's business, not the daemon's.
type Healthcheck struct {
	Test    []string
	Disable bool
}

// Mount is one entry of a service's `volumes`, in the long syntax Compose
// normalizes to. Type is "volume", "bind", "tmpfs", or "npipe".
type Mount struct {
	Type     string
	Source   string
	Target   string
	ReadOnly bool
}

// Port is one published or exposed port. Published is empty when the service
// only declares a container port.
type Port struct {
	Target    int
	Published string
	Protocol  string
	Mode      string
	HostIP    string
}

// Limits is the resource ceiling from `deploy.resources.limits`.
type Limits struct {
	CPUs   string
	Memory string
}

// Network is one top-level network.
type Network struct {
	Name     string
	Driver   string
	External bool
	Internal bool
}

// Volume is one top-level volume. DriverOpts is carried because the policy
// rejects it: `local` with `o=bind` and a `device` is a host bind mount written
// as a named volume, and nothing else about a named volume needs options.
type Volume struct {
	Name       string
	Driver     string
	External   bool
	DriverOpts map[string]string
}

// FileSource is one top-level config or secret. Only the repository file
// reference is carried: policy has to see where it points, and the contents
// are Docker's to read, not Cockpit's to hold.
type FileSource struct {
	Name     string
	File     string
	External bool
}

// parseModel turns `docker compose config --format json` output into a Model.
func parseModel(raw []byte) (*Model, error) {
	var doc document

	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse compose config output: %w", err)
	}

	m := &Model{
		Name:     doc.Name,
		Services: make(map[string]Service, len(doc.Services)),
		Networks: make(map[string]Network, len(doc.Networks)),
		Volumes:  make(map[string]Volume, len(doc.Volumes)),
		Configs:  make(map[string]FileSource, len(doc.Configs)),
		Secrets:  make(map[string]FileSource, len(doc.Secrets)),
		Raw:      raw,
	}

	for name, s := range doc.Services {
		m.Services[name] = s.service(name)
	}

	for name, n := range doc.Networks {
		m.Networks[name] = Network{
			Name:     firstNonEmpty(n.Name, name),
			Driver:   n.Driver,
			External: n.External,
			Internal: n.Internal,
		}
	}

	for name, v := range doc.Volumes {
		m.Volumes[name] = Volume{
			Name:       firstNonEmpty(v.Name, name),
			Driver:     v.Driver,
			External:   v.External,
			DriverOpts: v.DriverOpts,
		}
	}

	for name, c := range doc.Configs {
		m.Configs[name] = FileSource{Name: firstNonEmpty(c.Name, name), File: c.File, External: c.External}
	}

	for name, s := range doc.Secrets {
		m.Secrets[name] = FileSource{Name: firstNonEmpty(s.Name, name), File: s.File, External: s.External}
	}

	return m, nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}

	return b
}

// The wire types below mirror the JSON `docker compose config` emits. They are
// separate from the model because that JSON has several shapes per field —
// maps or lists, strings or numbers — and the model should not.

type document struct {
	Name     string                    `json:"name"`
	Services map[string]wireService    `json:"services"`
	Networks map[string]wireNetwork    `json:"networks"`
	Volumes  map[string]wireVolume     `json:"volumes"`
	Configs  map[string]wireFileSource `json:"configs"`
	Secrets  map[string]wireFileSource `json:"secrets"`
}

type wireService struct {
	Image       string           `json:"image"`
	Build       *wireBuild       `json:"build"`
	Command     stringList       `json:"command"`
	Entrypoint  stringList       `json:"entrypoint"`
	Environment envMap           `json:"environment"`
	EnvFile     envFileList      `json:"env_file"`
	Healthcheck *wireHealthcheck `json:"healthcheck"`
	Networks    keyList          `json:"networks"`
	DependsOn   keyList          `json:"depends_on"`
	Volumes     []wireMount      `json:"volumes"`
	Profiles    []string         `json:"profiles"`
	Restart     string           `json:"restart"`
	Deploy      *wireDeploy      `json:"deploy"`

	Privileged        bool       `json:"privileged"`
	ContainerName     string     `json:"container_name"`
	PID               string     `json:"pid"`
	IPC               string     `json:"ipc"`
	UTS               string     `json:"uts"`
	NetworkMode       string     `json:"network_mode"`
	UsernsMode        string     `json:"userns_mode"`
	Cgroup            string     `json:"cgroup"`
	CgroupParent      string     `json:"cgroup_parent"`
	Devices           deviceList `json:"devices"`
	DeviceCgroupRules stringList `json:"device_cgroup_rules"`
	CapAdd            stringList `json:"cap_add"`
	SecurityOpt       stringList `json:"security_opt"`
	VolumesFrom       stringList `json:"volumes_from"`
	Ports             []wirePort `json:"ports"`
}

func (w wireService) service(name string) Service {
	s := Service{
		Name:              name,
		Image:             w.Image,
		Command:           w.Command,
		Entrypoint:        w.Entrypoint,
		Environment:       w.Environment,
		EnvFiles:          w.EnvFile,
		Networks:          w.Networks,
		DependsOn:         w.DependsOn,
		Profiles:          w.Profiles,
		Restart:           w.Restart,
		Privileged:        w.Privileged,
		ContainerName:     w.ContainerName,
		PID:               w.PID,
		IPC:               w.IPC,
		UTS:               w.UTS,
		NetworkMode:       w.NetworkMode,
		UsernsMode:        w.UsernsMode,
		Cgroup:            w.Cgroup,
		CgroupParent:      w.CgroupParent,
		Devices:           w.Devices,
		DeviceCgroupRules: w.DeviceCgroupRules,
		CapAdd:            w.CapAdd,
		SecurityOpt:       w.SecurityOpt,
		VolumesFrom:       w.VolumesFrom,
	}

	if w.Build != nil {
		s.Build = &Build{
			Context:    w.Build.Context,
			Dockerfile: w.Build.Dockerfile,
			Target:     w.Build.Target,
			Args:       w.Build.Args,
		}
	}

	if w.Healthcheck != nil {
		s.Healthcheck = &Healthcheck{Test: w.Healthcheck.Test, Disable: w.Healthcheck.Disable}
	}

	if w.Deploy != nil && w.Deploy.Resources.Limits != nil {
		s.Limits = &Limits{
			CPUs:   string(w.Deploy.Resources.Limits.CPUs),
			Memory: string(w.Deploy.Resources.Limits.Memory),
		}
	}

	for _, m := range w.Volumes {
		s.Mounts = append(s.Mounts, Mount(m))
	}

	for _, p := range w.Ports {
		s.Ports = append(s.Ports, Port{
			Target:    p.Target,
			Published: string(p.Published),
			Protocol:  p.Protocol,
			Mode:      p.Mode,
			HostIP:    p.HostIP,
		})
	}

	return s
}

type wireBuild struct {
	Context    string            `json:"context"`
	Dockerfile string            `json:"dockerfile"`
	Target     string            `json:"target"`
	Args       map[string]string `json:"args"`
}

type wireHealthcheck struct {
	Test    stringList `json:"test"`
	Disable bool       `json:"disable"`
}

type wireDeploy struct {
	Resources struct {
		Limits *struct {
			CPUs   scalarString `json:"cpus"`
			Memory scalarString `json:"memory"`
		} `json:"limits"`
	} `json:"resources"`
}

type wireNetwork struct {
	Name     string `json:"name"`
	Driver   string `json:"driver"`
	External bool   `json:"external"`
	Internal bool   `json:"internal"`
}

type wireVolume struct {
	Name       string            `json:"name"`
	Driver     string            `json:"driver"`
	External   bool              `json:"external"`
	DriverOpts map[string]string `json:"driver_opts"`
}

type wireFileSource struct {
	Name     string `json:"name"`
	File     string `json:"file"`
	External bool   `json:"external"`
}

// wireMount is one entry of a service's `volumes`. Normalization always emits
// the long syntax, so the short "src:dst:mode" string never reaches here; a
// document that carried one would fail to parse rather than be reinterpreted
// by a second, worse copy of Compose's own rule.
type wireMount struct {
	Type     string `json:"type"`
	Source   string `json:"source"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"read_only"`
}

type wirePort struct {
	Target    int          `json:"target"`
	Published scalarString `json:"published"`
	Protocol  string       `json:"protocol"`
	Mode      string       `json:"mode"`
	HostIP    string       `json:"host_ip"`
}

// stringList is a Compose field that may be a bare string or a list of them —
// command, entrypoint, cap_add, healthcheck test. Normalization emits null for
// a service that declares none, which is not a one-element list of "".
type stringList []string

func (l *stringList) UnmarshalJSON(b []byte) error {
	if isNull(b) {
		*l = nil

		return nil
	}

	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*l = []string{s}

		return nil
	}

	var list []string
	if err := json.Unmarshal(b, &list); err != nil {
		return fmt.Errorf("parse string list: %w", err)
	}

	*l = list

	return nil
}

// keyList is a Compose field that may be a list of names or a map keyed by
// them — networks, depends_on. Only the names are kept; aliases and conditions
// are Docker's business.
type keyList []string

func (l *keyList) UnmarshalJSON(b []byte) error {
	var list []string
	if err := json.Unmarshal(b, &list); err == nil {
		*l = list

		return nil
	}

	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return fmt.Errorf("parse name list: %w", err)
	}

	*l = slices.Sorted(maps.Keys(m))

	return nil
}

// envMap is `environment` after normalization: a map whose values may be null
// for "pass through from the daemon's environment".
type envMap map[string]string

func (e *envMap) UnmarshalJSON(b []byte) error {
	var m map[string]*string
	if err := json.Unmarshal(b, &m); err != nil {
		return fmt.Errorf("parse environment: %w", err)
	}

	out := make(envMap, len(m))

	for k, v := range m {
		if v != nil {
			out[k] = *v
		} else {
			out[k] = ""
		}
	}

	*e = out

	return nil
}

// deviceList is `devices`, either "host:container:perms" strings or the long
// syntax objects. Rendered back to the string form so an error can quote it.
type deviceList []string

func (l *deviceList) UnmarshalJSON(b []byte) error {
	var entries []json.RawMessage
	if err := json.Unmarshal(b, &entries); err != nil {
		return fmt.Errorf("parse devices: %w", err)
	}

	out := make(deviceList, 0, len(entries))

	for _, e := range entries {
		var s string
		if err := json.Unmarshal(e, &s); err == nil {
			out = append(out, s)

			continue
		}

		var long struct {
			Source      string `json:"source"`
			Target      string `json:"target"`
			Permissions string `json:"permissions"`
		}

		if err := json.Unmarshal(e, &long); err != nil {
			return fmt.Errorf("parse device: %w", err)
		}

		parts := []string{long.Source}
		if long.Target != "" {
			parts = append(parts, long.Target)
		}

		if long.Permissions != "" {
			parts = append(parts, long.Permissions)
		}

		out = append(out, strings.Join(parts, ":"))
	}

	*l = out

	return nil
}

// envFileList is `env_file`. Current Compose emits a list of objects carrying
// a path and whether it is required; before the `required` field existed it
// emitted bare strings. Both are accepted because a shape this package failed
// to read would silently look like a service with no env files at all, and
// policy would have nothing to reject.
type envFileList []string

func (l *envFileList) UnmarshalJSON(b []byte) error {
	if isNull(b) {
		*l = nil

		return nil
	}

	var entries []json.RawMessage
	if err := json.Unmarshal(b, &entries); err != nil {
		return fmt.Errorf("parse env_file: %w", err)
	}

	out := make(envFileList, 0, len(entries))

	for _, e := range entries {
		var s string
		if err := json.Unmarshal(e, &s); err == nil {
			out = append(out, s)

			continue
		}

		var long struct {
			Path string `json:"path"`
		}

		if err := json.Unmarshal(e, &long); err != nil {
			return fmt.Errorf("parse env_file entry: %w", err)
		}

		out = append(out, long.Path)
	}

	*l = out

	return nil
}

// scalarString is a field Compose emits as a string in some versions and a
// number in others — published ports, cpu and memory limits.
type scalarString string

func (s *scalarString) UnmarshalJSON(b []byte) error {
	var str string
	if err := json.Unmarshal(b, &str); err == nil {
		*s = scalarString(str)

		return nil
	}

	var num json.Number
	if err := json.Unmarshal(b, &num); err != nil {
		return fmt.Errorf("parse scalar: %w", err)
	}

	*s = scalarString(num.String())

	return nil
}

// isNull reports a JSON null. UnmarshalJSON is called for one, and every
// tolerant type here would otherwise read it as a value rather than absence.
func isNull(b []byte) bool {
	return string(b) == "null"
}
