package compose

import (
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"strings"
)

// Policy is Cockpit's initial Compose policy (ADR-0012). It is an explicit
// deny-list, not deny-by-default: a Compose field this file does not name is
// allowed and runs unchanged. What it names are the fields that hand a
// container the host, plus every path the repository can point at something
// outside the checkout.
//
// The distinction matters when reading a deployment that was accepted. It says
// "none of the listed escapes are present", not "everything in this document
// was approved" — a Compose field added upstream is permitted until it is
// listed here, so extending this list is how the policy tightens.
//
// The rejected set is fixed rather than configurable. Only the external
// networks a Project may attach to vary by server, because the shared ingress
// network is created outside any Project.
type Policy struct {
	// ExternalNetworks are the pre-existing networks a Project may attach to
	// by name — in practice the shared ingress network Traefik lives on.
	ExternalNetworks []string
}

// Violation is one rejected field, located precisely enough to fix.
type Violation struct {
	// Service is the Compose service key, empty for a top-level field.
	Service string
	// Field is the Compose field path within the service or document.
	Field string
	// Value is what the effective model asked for.
	Value string
	// Reason says why Cockpit will not run it.
	Reason string
}

func (v Violation) path() string {
	if v.Service == "" {
		return v.Field
	}

	return "services." + v.Service + "." + v.Field
}

func (v Violation) String() string {
	if v.Value == "" {
		return fmt.Sprintf("%s: %s", v.path(), v.Reason)
	}

	return fmt.Sprintf("%s: %s: %s", v.path(), v.Value, v.Reason)
}

// PolicyError carries every violation in the model, not just the first: an
// operator fixing a repository should see the whole list in one deployment.
type PolicyError struct {
	Violations []Violation
}

func (e *PolicyError) Error() string {
	parts := make([]string, 0, len(e.Violations))
	for _, v := range e.Violations {
		parts = append(parts, v.String())
	}

	return fmt.Sprintf("compose policy: %d violation(s): %s", len(e.Violations), strings.Join(parts, "; "))
}

// Validate reports every field of the effective model that Cockpit refuses to
// run, and every file the model names that lies outside the checkout. It
// returns nil or a *PolicyError. Callers run it before build and apply, so a
// rejected model never reaches the box's Docker daemon.
//
// It takes the Request because the path rules are about a real directory on
// this box: whether a reference stays inside it cannot be decided from the
// text of the document alone. The documents themselves are not checked here —
// they were checked before Docker was allowed to open them, in Request.
func (p Policy) Validate(req Request, m *Model) error {
	paths, err := newPathChecker(req.Dir)
	if err != nil {
		return &PolicyError{Violations: []Violation{{
			Field: "project directory", Value: req.Dir, Reason: err.Error(),
		}}}
	}

	var violations []Violation

	for _, name := range m.ServiceNames() {
		violations = append(violations, p.validateService(paths, m.Services[name])...)
	}

	violations = append(violations, p.validateNetworks(m)...)
	violations = append(violations, volumeViolations(m)...)
	violations = append(violations, fileSourceViolations(paths, "configs", m.Configs)...)
	violations = append(violations, fileSourceViolations(paths, "secrets", m.Secrets)...)

	if len(violations) == 0 {
		return nil
	}

	return &PolicyError{Violations: violations}
}

func (p Policy) validateService(paths pathChecker, s Service) []Violation {
	var out []Violation

	if s.Privileged {
		out = append(out, Violation{s.Name, "privileged", "true", "a privileged container owns the host"})
	}

	if len(s.CapAdd) > 0 {
		out = append(out, Violation{
			s.Name, "cap_add", strings.Join(s.CapAdd, ","),
			"added capabilities escape the container boundary",
		})
	}

	for _, d := range s.Devices {
		out = append(out, Violation{s.Name, "devices", d, "host devices are not exposed to project containers"})
	}

	if s.PID != "" {
		out = append(out, Violation{s.Name, "pid", s.PID, "a shared process namespace exposes other containers and the host"})
	}

	if s.IPC != "" {
		out = append(out, Violation{s.Name, "ipc", s.IPC, "a shared IPC namespace exposes other containers and the host"})
	}

	if s.UTS != "" {
		out = append(out, Violation{
			s.Name, "uts", s.UTS,
			"a shared UTS namespace lets a container rename the host",
		})
	}

	if s.UsernsMode != "" {
		out = append(out, Violation{
			s.Name, "userns_mode", s.UsernsMode,
			"a shared user namespace maps container root onto host root",
		})
	}

	if s.Cgroup != "" {
		out = append(out, Violation{
			s.Name, "cgroup", s.Cgroup,
			"a shared cgroup namespace exposes the host's resource control",
		})
	}

	if s.CgroupParent != "" {
		out = append(out, Violation{
			s.Name, "cgroup_parent", s.CgroupParent,
			"Cockpit owns the cgroup a project's containers are accounted under",
		})
	}

	if len(s.SecurityOpt) > 0 {
		out = append(out, Violation{
			s.Name, "security_opt", strings.Join(s.SecurityOpt, ","),
			"security options undo the seccomp and AppArmor confinement the container relies on",
		})
	}

	if len(s.DeviceCgroupRules) > 0 {
		out = append(out, Violation{
			s.Name, "device_cgroup_rules", strings.Join(s.DeviceCgroupRules, ","),
			"device cgroup rules grant access to host devices",
		})
	}

	if len(s.VolumesFrom) > 0 {
		out = append(out, Violation{
			s.Name, "volumes_from", strings.Join(s.VolumesFrom, ","),
			"volumes_from mounts another container's filesystem, including one outside this project",
		})
	}

	if s.NetworkMode != "" {
		out = append(out, Violation{
			s.Name, "network_mode", s.NetworkMode,
			"services join project networks; host and container network modes bypass them",
		})
	}

	if s.ContainerName != "" {
		out = append(out, Violation{
			s.Name, "container_name", s.ContainerName,
			"Cockpit owns container naming so a project's containers stay attributable",
		})
	}

	out = append(out, portViolations(s)...)
	out = append(out, mountViolations(s)...)
	out = append(out, buildViolations(paths, s)...)

	for _, path := range s.EnvFiles {
		if v := paths.check(s.Name, "env_file", path, path); v != nil {
			out = append(out, *v)
		}
	}

	return out
}

func buildViolations(paths pathChecker, s Service) []Violation {
	if s.Build == nil {
		return nil
	}

	if v := paths.check(s.Name, "build.context", s.Build.Context, s.Build.Context); v != nil {
		// The Dockerfile resolves against a context already refused, so
		// reporting it too would name the same mistake twice.
		return []Violation{*v}
	}

	dockerfile := s.Build.Dockerfile
	if dockerfile == "" {
		return nil
	}

	// The Dockerfile is checked on its own and joined to its context: an
	// absolute path stops looking absolute once it is joined to anything, and
	// the context is where Docker resolves a relative one from.
	for _, checked := range []string{dockerfile, filepath.Join(s.Build.Context, dockerfile)} {
		if v := paths.check(s.Name, "build.dockerfile", dockerfile, checked); v != nil {
			return []Violation{*v}
		}
	}

	return nil
}

// A config or secret sourced from a file reads that file off the box at apply
// time, so it is held to the same rule as everything else the repository names.
// An external one names a Swarm object the project did not create and Cockpit
// cannot see the contents of, which is the same reach as an external volume.
func fileSourceViolations(paths pathChecker, kind string, sources map[string]FileSource) []Violation {
	var out []Violation

	for _, key := range slices.Sorted(maps.Keys(sources)) {
		source := sources[key]

		if source.External {
			out = append(out, Violation{
				"", kind + "." + key + ".external", source.Name,
				"an external " + strings.TrimSuffix(kind, "s") + " comes from outside the project; " +
					"Cockpit deploys only what the repository declares",
			})
		}

		if v := paths.check("", kind+"."+key+".file", source.File, source.File); v != nil {
			out = append(out, *v)
		}
	}

	return out
}

// A top-level volume is Docker-managed and belongs to the project. External
// means an existing volume the project did not create — someone else's data —
// and driver options are how a named volume becomes a host bind mount: `local`
// with `o=bind` and a `device` mounts any path on the box under a name that
// reads as ordinary. Neither is reachable through mountViolations, which sees
// only what a service asked to mount.
func volumeViolations(m *Model) []Violation {
	var out []Violation

	for _, key := range slices.Sorted(maps.Keys(m.Volumes)) {
		v := m.Volumes[key]

		if v.External {
			out = append(out, Violation{
				"", "volumes." + key + ".external", v.Name,
				"external volumes hold data this project does not own; declare the volume in the project",
			})
		}

		if len(v.DriverOpts) > 0 {
			out = append(out, Violation{
				"", "volumes." + key + ".driver_opts", strings.Join(slices.Sorted(maps.Keys(v.DriverOpts)), ","),
				"volume driver options can bind a host path under a named volume",
			})
		}
	}

	return out
}

// Only Traefik publishes host ports. A project service reaches the internet
// through the ingress service and its domains instead.
func portViolations(s Service) []Violation {
	var out []Violation

	for _, port := range s.Ports {
		if port.Published == "" {
			continue
		}

		value := port.Published
		if port.HostIP != "" {
			value = port.HostIP + ":" + value
		}

		out = append(out, Violation{
			s.Name, "ports", value,
			"only the shared proxy publishes host ports; expose the service through ingress",
		})
	}

	return out
}

func mountViolations(s Service) []Violation {
	var out []Violation

	for _, m := range s.Mounts {
		switch m.Type {
		case "volume", "":
			// A named or anonymous volume is Docker-managed and allowed.
			continue
		case "bind":
			out = append(out, Violation{s.Name, "volumes", mountValue(m), bindReason(m.Source)})
		default:
			out = append(out, Violation{
				s.Name, "volumes", mountValue(m),
				fmt.Sprintf("mount type %q is not supported; use a named volume", m.Type),
			})
		}
	}

	return out
}

// The Docker socket is a bind mount like any other, but it is root on the box
// and every other container, so it gets said out loud.
func bindReason(source string) string {
	if strings.Contains(source, "docker.sock") {
		return "mounting the Docker socket gives the container the whole box"
	}

	return "host bind mounts are not allowed; use a named volume"
}

func mountValue(m Mount) string {
	if m.Source == "" {
		return m.Target
	}

	return m.Source + ":" + m.Target
}

// An external network is one Cockpit did not create for this project, so
// joining it reaches whatever else is already on it. Only the networks the
// server approves — the shared ingress network — are allowed. Internal
// project-defined networks, custom ones included, are preserved untouched.
//
// The allow-list is matched against Name only, which is the network Docker
// actually joins. The key is a label local to the document and the repository
// chooses it freely, so honouring it would let `networks: {cockpit-ingress:
// {name: someone-elses-network, external: true}}` name its way onto any network
// on the box. Normalization always fills Name in, falling back to the key when
// the document gave none — see parseModel.
func (p Policy) validateNetworks(m *Model) []Violation {
	allowed := make(map[string]bool, len(p.ExternalNetworks))
	for _, n := range p.ExternalNetworks {
		allowed[n] = true
	}

	var out []Violation

	for _, key := range slices.Sorted(maps.Keys(m.Networks)) {
		n := m.Networks[key]
		if !n.External || allowed[n.Name] {
			continue
		}

		out = append(out, Violation{
			"", "networks." + key + ".external", n.Name,
			"external networks must be approved for this server",
		})
	}

	return out
}
