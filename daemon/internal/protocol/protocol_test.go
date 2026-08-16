package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func validChunk() StreamData {
	return StreamData{
		Type: TypeStreamData,
		// The stream id IS the Deployment id — the plane authorizes and addresses
		// the log's Durable Object by it, so it is not a composite label.
		StreamID: "dep_1",
		Seq:      7,
		Stage:    LogStageBuild,
		Source:   LogSourceStderr,
		Data:     "#4 [2/6] RUN go build ./...",
		At:       1_700_000_000_000,
	}
}

func TestStreamDataValidate(t *testing.T) {
	if err := validChunk().Validate(); err != nil {
		t.Fatalf("valid chunk rejected: %v", err)
	}

	cases := map[string]func(*StreamData){
		"wrong type":   func(s *StreamData) { s.Type = TypeState },
		"no stream id": func(s *StreamData) { s.StreamID = "" },
		// A stage the plane does not know is refused here rather than sent and
		// closed over: the stage set is the contract, not a free-text label.
		"unknown stage":  func(s *StreamData) { s.Stage = "deploying" },
		"unknown source": func(s *StreamData) { s.Source = "console" },
		"oversized data": func(s *StreamData) { s.Data = strings.Repeat("x", MaxLogChunkBytes+1) },
		// Invalid bytes pass len() unchanged and then become a three-byte U+FFFD
		// each in JSON, so a frame under the limit here can land at the plane
		// three times over it. Refused rather than sent and closed over.
		"invalid utf-8": func(s *StreamData) { s.Data = "build \xff\xfe output" },
		"data that would triple in json": func(s *StreamData) {
			s.Data = strings.Repeat("\xff", MaxLogChunkBytes)
		},
		"no timestamp": func(s *StreamData) { s.At = 0 },
	}

	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			chunk := validChunk()
			mutate(&chunk)
			if err := chunk.Validate(); err == nil {
				t.Fatalf("%s was accepted", name)
			}
		})
	}
}

// The plane matches on these exact JSON names (apps/plane/src/schema.ts). A
// rename here is a silent wire break, so the encoded shape is asserted whole.
func TestStreamDataWireShape(t *testing.T) {
	chunk := validChunk()
	chunk.Dropped = 3
	chunk.Final = true

	encoded, err := json.Marshal(chunk)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	want := []string{"type", "stream_id", "seq", "stage", "source", "data", "at", "dropped", "final"}
	for _, key := range want {
		if _, ok := decoded[key]; !ok {
			t.Errorf("missing %q on the wire", key)
		}
	}
	if len(decoded) != len(want) {
		t.Errorf("unexpected fields on the wire: got %v, want exactly %v", keys(decoded), want)
	}

	// Loss markers are omitted when there is nothing to report, so the common
	// chunk stays small — but they must be omitted, not sent as a wrong zero.
	quiet, err := json.Marshal(validChunk())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{`"dropped"`, `"final"`} {
		if strings.Contains(string(quiet), key) {
			t.Errorf("%s should be omitted when unset", key)
		}
	}
}

// The plane's limit is the decoded string's utf-8 length, and this one is
// len(). They agree only while Data is valid utf-8 — so a chunk full of
// box-drawing characters, right at the limit, must weigh the same on both sides
// of a JSON round trip.
func TestStreamDataMultibyteChunkKeepsItsByteCountAcrossJSON(t *testing.T) {
	const bar = "─┤ building ├─" // 3-byte runes and ASCII

	chunk := validChunk()
	for len(chunk.Data)+len(bar) <= MaxLogChunkBytes {
		chunk.Data += bar
	}

	if err := chunk.Validate(); err != nil {
		t.Fatalf("valid chunk rejected: %v", err)
	}

	encoded, err := json.Marshal(chunk)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded StreamData
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Data != chunk.Data {
		t.Fatal("data did not survive the round trip")
	}

	if len(decoded.Data) != len(chunk.Data) || len(decoded.Data) > MaxLogChunkBytes {
		t.Fatalf("%d bytes became %d, limit %d", len(chunk.Data), len(decoded.Data), MaxLogChunkBytes)
	}
}

func keys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
