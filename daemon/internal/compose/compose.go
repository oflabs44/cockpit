// Package compose normalizes, validates, and executes a project's effective
// Docker Compose model on the box.
//
// A Cockpit Project is one GitHub-backed Compose stack (ADR-0012). The
// repository's own file defines the workload; the Plane generates an override
// for release images, labels, and the ingress network. Neither is authoritative
// on its own: `docker compose config` merges, interpolates, and normalizes them,
// and the result is what deployment builds, applies, and snapshots. The
// repository file is never rewritten.
//
// Docker is the authority for what a Compose document means. This package adds
// only the three things Docker will not do: a typed view of the merged result,
// Cockpit's policy over it, and the deployment order build -> migrate -> apply.
package compose

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// Runner runs a command in a working directory and returns its stdout.
// Injected so normalization is testable without Docker present.
type Runner func(ctx context.Context, dir, name string, args ...string) ([]byte, error)

// Emit receives one chunk of a running command's output. Chunks arrive while
// the command runs, in order per stream, and never concurrently. The chunk
// belongs to the receiver; the runner does not reuse it.
//
// A chunk is valid UTF-8 of at most chunkLimit bytes — the bound the protocol
// frame is checked against, measured the way the Plane measures it. See pump.
type Emit func(stream Stream, chunk []byte)

// StreamRunner runs a command in a working directory, delivering its output
// through emit as it is produced, and returns when the command has exited.
// Injected so the execution verbs are testable without Docker present.
type StreamRunner func(ctx context.Context, dir, name string, args []string, emit Emit) error

// Stream says which of a command's two output streams a chunk came from. A
// deployment log has to keep them apart: Compose reports progress on stderr
// and a migration's own output is usually stdout.
type Stream string

const (
	Stdout Stream = "stdout"
	Stderr Stream = "stderr"
)

// Stage is the deployment step a chunk belongs to. It is carried with the
// chunk so one sink can serve the whole deployment without the caller
// relabelling between calls.
type Stage string

const (
	StageBuild   Stage = "build"
	StageMigrate Stage = "migrate"
	StageApply   Stage = "apply"
)

// Output is one chunk of a stage's output, as it was produced.
type Output struct {
	Stage  Stage
	Stream Stream
	Bytes  []byte
}

// Sink receives a deployment's output as it happens. The execution verbs call
// it from a single goroutine at a time and return only after the last chunk
// has been delivered, so a sink that forwards to the Plane sees the same order
// the box produced. A nil Sink discards the output.
type Sink func(Output)

// CLI runs `docker compose` for one project on this box.
type CLI struct {
	Bin string
	// Exec captures a command's stdout, for the verbs whose output is data.
	// Named for what it does rather than Run, which is a Compose verb.
	Exec Runner
	// StreamExec runs a command whose output is a log, not a value.
	StreamExec StreamRunner
}

// New returns a CLI using the docker binary on PATH.
func New() *CLI {
	return &CLI{Bin: "docker", Exec: execRun, StreamExec: execStream}
}

// Request is one project's Compose identity: a project name, the directory the
// documents are resolved against, and the documents themselves in merge order.
// Every verb takes the same Request, because a stack built under one identity
// and applied under another is two stacks.
type Request struct {
	// ProjectName is the Compose project name. It is stable per Cockpit
	// Project, so a redeploy replaces the same stack.
	ProjectName string
	// Dir is the project directory: the checkout plus the Project's base
	// directory. Relative paths inside the documents resolve against it.
	Dir string
	// Files are the documents in merge order, relative to Dir. The
	// repository's own file comes first, the generated override last.
	Files []string
}

// args builds the whole docker argument list for one Compose verb. Every verb
// goes through here so the project name, the project directory, and the file
// order cannot diverge between normalizing, building, migrating, and applying.
func (r Request) args(verb ...string) []string {
	args := make([]string, 0, 6+2*len(r.Files)+len(verb))
	args = append(args, "compose", "--project-name", r.ProjectName, "--project-directory", r.Dir)

	for _, f := range r.Files {
		args = append(args, "--file", f)
	}

	return append(args, verb...)
}

// Normalize merges and resolves the request's documents into the effective
// model. It does not validate policy; see Policy.Validate.
//
// Path and env-file resolution stay off. Resolved, the output would carry
// absolute host paths that hide whether the repository asked for a file inside
// the checkout, and the contents of every env file, which are the Project's
// secrets and would land in the Release snapshot. Unresolved, the model shows
// what the repository actually wrote, which is what policy has to judge.
// Interpolation stays on: variable values are part of the effective model.
func (c *CLI) Normalize(ctx context.Context, req Request) (*Model, error) {
	if err := req.validate(); err != nil {
		return nil, err
	}

	args := req.args("config", "--format", "json", "--no-env-resolution", "--no-path-resolution")

	out, err := c.Exec(ctx, req.Dir, c.bin(), args...)
	if err != nil {
		return nil, fmt.Errorf("normalize compose model: %w", err)
	}

	return parseModel(out)
}

// Build builds every buildable service in the project. Builds finish before
// apply so no running container is replaced by an image that then fails to
// build (ADR-0012).
func (c *CLI) Build(ctx context.Context, req Request, sink Sink) error {
	return c.run(ctx, req, StageBuild, sink, "build project images", "build")
}

// RunMigration runs one service as a one-shot container and waits for it. The
// container is removed afterwards; a non-zero exit is an error, because a
// deployment must not apply over a failed migration.
//
// The Plane names the service and the repository decides whether it exists, so
// a setting left behind by a repository change fails here, before any image is
// applied, rather than as a Docker error halfway through.
//
// command overrides the service's own command, which is the Project's optional
// migration command. Empty means run the service as the repository defined it.
// Compose passes everything after the service name to the container, so an
// override that starts with a dash is an argument, not a flag to Compose.
func (c *CLI) RunMigration(
	ctx context.Context, req Request, m *Model, service string, command []string, sink Sink,
) error {
	if service == "" {
		return fmt.Errorf("compose migrate: no migration service named")
	}

	if m == nil {
		return fmt.Errorf("compose migrate: no effective model to check %q against", service)
	}

	if _, ok := m.Services[service]; !ok {
		return fmt.Errorf(
			"compose migrate: the effective model has no service %q; it has %s",
			service, strings.Join(m.ServiceNames(), ", "),
		)
	}

	verb := append([]string{"run", "--rm", "--no-TTY", service}, command...)

	return c.run(ctx, req, StageMigrate, sink, fmt.Sprintf("run migration service %q", service), verb...)
}

// Apply brings the project to the effective model. It never builds: the images
// exist by now, and a build here would change a running stack halfway through.
// Orphans go because a service the repository deleted must stop running.
func (c *CLI) Apply(ctx context.Context, req Request, sink Sink) error {
	return c.run(ctx, req, StageApply, sink, "apply compose project",
		"up", "--detach", "--no-build", "--remove-orphans")
}

// run is the one execution path behind Build, RunMigration, and Apply.
func (c *CLI) run(ctx context.Context, req Request, stage Stage, sink Sink, what string, verb ...string) error {
	if err := req.validate(); err != nil {
		return err
	}

	if c.StreamExec == nil {
		return fmt.Errorf("%s: no command runner", what)
	}

	emit := func(stream Stream, chunk []byte) {
		if sink == nil {
			return
		}

		sink(Output{Stage: stage, Stream: stream, Bytes: chunk})
	}

	if err := c.StreamExec(ctx, req.Dir, c.bin(), req.args(verb...), emit); err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}

	return nil
}

func (c *CLI) bin() string {
	if c.Bin != "" {
		return c.Bin
	}

	return "docker"
}

// validate rejects a request before it reaches the CLI. The Compose paths come
// from the Plane and are resolved inside a checkout the daemon just made, so
// they must not be able to name anything outside it.
//
// The check runs here, ahead of every verb, rather than with the rest of the
// path policy: these are the files Docker opens in order to produce the model
// the policy then judges, so by the time there is a model to judge, a document
// symlinked out of the checkout has already been read.
func (r Request) validate() error {
	if r.ProjectName == "" {
		return fmt.Errorf("compose request: no project name")
	}

	if len(r.Files) == 0 {
		return fmt.Errorf("compose request: no compose files")
	}

	paths, err := newPathChecker(r.Dir)
	if err != nil {
		return fmt.Errorf("compose request: %w", err)
	}

	for _, f := range r.Files {
		if f == "" {
			return fmt.Errorf("compose request: empty compose file path")
		}

		if v := paths.check("", "compose file", f, f); v != nil {
			return fmt.Errorf("compose request: %s", v)
		}
	}

	return nil
}

func execRun(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}

	return stdout.Bytes(), nil
}

// chunkLimit bounds one delivered fragment, in bytes. Output is forwarded in
// fragments rather than lines because a build can emit megabytes without a
// newline — a progress bar, a minified asset, a stack trace — and a
// line-oriented reader either buffers all of it or gives up on it. The limit
// matches what the protocol sends in one frame.
const chunkLimit = protocol.MaxLogChunkBytes

// replacement is U+FFFD, what an invalid byte becomes. Three bytes, which is
// the whole reason it is substituted here rather than left to the encoder —
// see sanitize.
var replacement = []byte(string(utf8.RuneError))

// stderrTailLimit bounds what is kept to explain a failure. It is a tail, not
// a transcript: the log itself goes to the sink.
const stderrTailLimit = 4 * 1024

// execStream runs a command and hands its output on as it appears. A build or
// a migration can run for minutes, and an operator watching it needs the
// output now, not at the end.
func execStream(ctx context.Context, dir, name string, args []string, emit Emit) error {
	if emit == nil {
		emit = func(Stream, []byte) {}
	}

	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("%s: stdout: %w", name, err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("%s: stderr: %w", name, err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}

	// One lock over both pumps, so a sink forwarding to the Plane is never
	// called from two goroutines at once and never has to be safe itself.
	var mu sync.Mutex

	var tail stderrTail

	var readErr [2]error

	var wg sync.WaitGroup

	wg.Add(2)

	go func() {
		defer wg.Done()
		readErr[0] = pump(stdout, Stdout, &mu, emit, nil)
	}()

	go func() {
		defer wg.Done()
		readErr[1] = pump(stderr, Stderr, &mu, emit, &tail)
	}()

	wg.Wait()

	waitErr := cmd.Wait()

	if waitErr != nil {
		// The last stderr line is the reason Docker gives for the failure.
		// Without it a caller with no sink has an exit status and nothing else.
		if last := tail.lastLine(); last != "" {
			return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), waitErr, last)
		}

		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), waitErr)
	}

	// A command that exited cleanly but whose output could not be read fully
	// did not produce the log the caller was given. Saying so beats reporting
	// a success with a hole in it.
	for _, err := range readErr {
		if err != nil {
			return fmt.Errorf("%s %s: read output: %w", name, strings.Join(args, " "), err)
		}
	}

	return nil
}

// pump forwards one stream in bounded fragments of valid UTF-8, as they arrive.
// A fragment may split a line — the log is a byte stream and reassembly belongs
// to whatever renders it — but never a rune, and never carries a byte that is
// not part of one. Each fragment is a slice a sink may keep; nothing here
// overwrites it on the next read.
//
// The UTF-8 guarantee is a bound, not a nicety. `docker compose` draws its
// progress with box-drawing characters, so a read that ends mid-rune is the
// normal case, not an edge one. An invalid byte survives Go's byte-counted
// limit but becomes U+FFFD — three bytes — when the frame is JSON-encoded, so a
// chunk of 8192 invalid bytes passes here and arrives at the Plane as 24576,
// over a limit the Plane closes the socket for. Substituting at the seam that
// produces the chunk makes the byte count this package bounds the same byte
// count the Plane measures.
func pump(r io.Reader, stream Stream, mu *sync.Mutex, emit Emit, tail *stderrTail) error {
	buf := make([]byte, chunkLimit)

	// A rune split across two reads. At most utf8.UTFMax-1 bytes, held until the
	// read that completes it, or replaced when the stream ends without one.
	var carry []byte

	deliver := func(read []byte, atEOF bool) {
		var clean []byte

		clean, carry = sanitize(append(carry, read...), atEOF)

		for _, chunk := range fragments(clean) {
			mu.Lock()

			if tail != nil {
				tail.write(chunk)
			}

			emit(stream, chunk)
			mu.Unlock()
		}
	}

	for {
		n, err := r.Read(buf)

		if n > 0 {
			deliver(buf[:n], false)
		}

		if err != nil {
			// Whatever a truncated rune left behind is still the operator's
			// output, delivered as the replacement character rather than lost.
			deliver(nil, true)

			if errors.Is(err, io.EOF) {
				return nil
			}

			return err
		}
	}
}

// sanitize returns p as valid UTF-8, plus any trailing bytes that are the start
// of a rune the next read will finish. Every byte that cannot be part of a rune
// becomes U+FFFD. At EOF nothing is carried: an unfinished rune is replaced,
// because there is no next read to complete it.
func sanitize(p []byte, atEOF bool) (clean, carry []byte) {
	out := make([]byte, 0, len(p))

	for i := 0; i < len(p); {
		if p[i] < utf8.RuneSelf {
			out = append(out, p[i])
			i++

			continue
		}

		r, size := utf8.DecodeRune(p[i:])
		if r == utf8.RuneError && size <= 1 {
			if !atEOF && runePrefix(p[i:]) {
				return out, append([]byte(nil), p[i:]...)
			}

			out = append(out, replacement...)
			i++

			continue
		}

		out = append(out, p[i:i+size]...)
		i += size
	}

	return out, nil
}

// runePrefix reports whether p is the beginning of a rune whose remaining bytes
// have not arrived: a lead byte followed only by continuation bytes, and too
// short to be a whole rune.
func runePrefix(p []byte) bool {
	if len(p) == 0 || len(p) >= utf8.UTFMax || !utf8.RuneStart(p[0]) {
		return false
	}

	for _, b := range p[1:] {
		if utf8.RuneStart(b) {
			return false
		}
	}

	return true
}

// fragments splits valid UTF-8 into pieces of at most chunkLimit bytes, cutting
// only on a rune boundary. Sanitizing can grow a read — every invalid byte
// becomes three — so the limit is applied to what is delivered, not to what was
// read.
func fragments(p []byte) [][]byte {
	var out [][]byte

	for len(p) > 0 {
		n := len(p)

		if n > chunkLimit {
			for n = chunkLimit; n > 0 && !utf8.RuneStart(p[n]); n-- {
			}
		}

		out = append(out, p[:n:n])
		p = p[n:]
	}

	return out
}

// stderrTail keeps the end of a stream, so a failure can be explained without
// holding output that has already been delivered.
type stderrTail struct {
	buf []byte
}

func (t *stderrTail) write(p []byte) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > stderrTailLimit {
		t.buf = t.buf[len(t.buf)-stderrTailLimit:]
	}
}

// lastLine returns the last non-empty line the stream ended with.
func (t *stderrTail) lastLine() string {
	lines := strings.Split(string(t.buf), "\n")

	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}

	return ""
}
