package compose

// These test the streaming runner itself, most of it against a real child
// process. A build or an apply is watched while it runs, so "the output
// arrives before the command exits" is the behaviour, and a fake runner
// cannot prove it.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// waitForGate blocks the child until the test creates the file, so the test
// controls when the command finishes without sleeping for a guess.
const waitForGate = `printf 'building\n'; printf 'step 1/2\n' >&2; ` +
	`until [ -f "$1" ]; do sleep 0.01; done; printf 'built\n'`

const failsAfterOutput = `printf 'step 1/2\n'; printf 'failed to solve: no such file\n' >&2; exit 3`

func shell(t *testing.T) string {
	t.Helper()

	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no shell to run a child process with")
	}

	return sh
}

// run starts execStream in the background and returns the chunks as they
// arrive and the command's eventual error.
func run(t *testing.T, script string, args ...string) (<-chan string, <-chan error) {
	t.Helper()

	chunks := make(chan string, 16)
	done := make(chan error, 1)
	argv := append([]string{"-c", script, "sh"}, args...)
	sh, dir := shell(t), t.TempDir()

	go func() {
		done <- execStream(context.Background(), dir, sh, argv, func(stream Stream, chunk []byte) {
			chunks <- string(stream) + " " + strings.TrimRight(string(chunk), "\n")
		})
	}()

	return chunks, done
}

func awaitChunk(t *testing.T, chunks <-chan string, want string) {
	t.Helper()

	deadline := time.After(10 * time.Second)

	for {
		select {
		case got := <-chunks:
			if got == want {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q", want)
		}
	}
}

func TestExecStreamDeliversOutputBeforeTheCommandExits(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "gate")

	chunks, done := run(t, waitForGate, gate)

	awaitChunk(t, chunks, "stdout building")
	awaitChunk(t, chunks, "stderr step 1/2")

	// The command is still running: the output above was not buffered until
	// it exited, which is the whole point of streaming it.
	select {
	case err := <-done:
		t.Fatalf("command already finished (err = %v); output was not streamed", err)
	default:
	}

	if err := os.WriteFile(gate, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	awaitChunk(t, chunks, "stdout built")

	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("command did not exit")
	}
}

func TestExecStreamKeepsOutputAndReasonWhenTheCommandFails(t *testing.T) {
	chunks, done := run(t, failsAfterOutput)

	awaitChunk(t, chunks, "stdout step 1/2")
	awaitChunk(t, chunks, "stderr failed to solve: no such file")

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("want error")
		}

		// A caller with no sink still has to learn why it failed.
		if !strings.Contains(err.Error(), "failed to solve: no such file") {
			t.Fatalf("err = %q, want the last stderr line", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("command did not exit")
	}
}

// A build can emit megabytes without a newline. None of it may be dropped, and
// no single fragment may exceed what the protocol sends in one frame.
func TestPumpSplitsLongOutputWithoutLosingAny(t *testing.T) {
	const size = 3 << 20

	var (
		mu     sync.Mutex
		total  int
		chunks int
		widest int
	)

	err := pump(strings.NewReader(strings.Repeat("x", size)), Stdout, &mu, func(_ Stream, chunk []byte) {
		total += len(chunk)
		chunks++

		if len(chunk) > widest {
			widest = len(chunk)
		}
	}, nil)
	if err != nil {
		t.Fatal(err)
	}

	if total != size {
		t.Fatalf("delivered %d bytes of %d", total, size)
	}

	if widest > chunkLimit {
		t.Fatalf("widest fragment = %d, want at most %d", widest, chunkLimit)
	}

	if chunks < size/chunkLimit {
		t.Fatalf("fragments = %d, want the output split", chunks)
	}
}

// `docker compose` draws its progress with box-drawing characters, so a read
// that ends mid-rune is the ordinary case. Every fragment must be a frame the
// Plane will accept: valid UTF-8, within the byte limit *after* JSON has been
// through it, and the whole stream must survive the round trip unchanged.
func TestPumpDeliversMultibyteOutputAsFramesThePlaneAccepts(t *testing.T) {
	// Box drawing (3 bytes), an emoji (4 bytes), and ASCII, repeated past the
	// fragment limit so runes land across read boundaries in every alignment.
	input := strings.Repeat("─┤ building ├─ 🚀 ", 4096)

	var (
		mu    sync.Mutex
		got   strings.Builder
		seq   uint64
		frame int
	)

	err := pump(strings.NewReader(input), Stdout, &mu, func(_ Stream, chunk []byte) {
		frame++

		if !utf8.Valid(chunk) {
			t.Errorf("fragment %d is not valid utf-8", frame)
		}

		// The protocol's own check, on the frame this chunk becomes.
		data := protocol.StreamData{
			Type: protocol.TypeStreamData, StreamID: "dep_1", Seq: seq,
			Stage: protocol.LogStageBuild, Source: protocol.LogSourceStdout,
			Data: string(chunk), At: 1_700_000_000_000,
		}
		seq++

		if err := data.Validate(); err != nil {
			t.Errorf("fragment %d: %v", frame, err)
		}

		encoded, err := json.Marshal(data)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		var decoded protocol.StreamData
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}

		// What the Plane measures is the decoded string's utf-8 length. It must
		// be the same count the daemon bounded, not one JSON grew on the way.
		if len(decoded.Data) != len(chunk) {
			t.Errorf("fragment %d: %d bytes became %d across json", frame, len(chunk), len(decoded.Data))
		}

		if len(decoded.Data) > protocol.MaxLogChunkBytes {
			t.Errorf("fragment %d: %d bytes, over the protocol limit", frame, len(decoded.Data))
		}

		got.WriteString(decoded.Data)
	}, nil)
	if err != nil {
		t.Fatal(err)
	}

	if frame < 2 {
		t.Fatalf("fragments = %d, want the output split", frame)
	}

	if got.String() != input {
		t.Fatal("the reassembled stream is not what was written")
	}
}

// A build can print anything: a binary blob, latin-1 from an old toolchain, a
// truncated download. Those bytes must not travel as they are — JSON turns each
// one into a three-byte U+FFFD, so a frame that fits here would arrive at the
// Plane at three times its measured size, over a limit it closes the socket for.
func TestPumpReplacesInvalidBytesRatherThanLettingJSONTripleThem(t *testing.T) {
	// A whole fragment's worth of invalid bytes, which is the worst case.
	input := bytes.Repeat([]byte{0xff}, chunkLimit)

	var (
		mu       sync.Mutex
		total    int
		fragment int
	)

	err := pump(bytes.NewReader(input), Stderr, &mu, func(_ Stream, chunk []byte) {
		fragment++
		total += len(chunk)

		if !utf8.Valid(chunk) {
			t.Errorf("fragment %d is not valid utf-8", fragment)
		}

		if len(chunk) > chunkLimit {
			t.Errorf("fragment %d = %d bytes, over the %d limit", fragment, len(chunk), chunkLimit)
		}
	}, nil)
	if err != nil {
		t.Fatal(err)
	}

	// Nothing is dropped: every invalid byte is reported as one replacement
	// character, so the loss is visible in the log rather than silent.
	if want := chunkLimit * len(string(utf8.RuneError)); total != want {
		t.Fatalf("delivered %d bytes, want %d", total, want)
	}
}

// A stream that fails part way through has not delivered the log the caller
// was promised, so the failure travels rather than reading as a clean end.
func TestPumpReportsAReadFailure(t *testing.T) {
	var mu sync.Mutex

	var got []byte

	r := io.MultiReader(strings.NewReader("step 1/2\n"), errorReader{errors.New("input/output error")})

	err := pump(r, Stdout, &mu, func(_ Stream, chunk []byte) { got = append(got, chunk...) }, nil)
	if err == nil || !strings.Contains(err.Error(), "input/output error") {
		t.Fatalf("err = %v, want the read failure", err)
	}

	// What did arrive before the failure is still the operator's.
	if string(got) != "step 1/2\n" {
		t.Fatalf("delivered %q", got)
	}
}

type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

func TestExecStreamReportsAMissingBinary(t *testing.T) {
	err := execStream(context.Background(), t.TempDir(), "cockpit-no-such-binary", []string{"x"}, nil)
	if err == nil {
		t.Fatal("want error")
	}
}
