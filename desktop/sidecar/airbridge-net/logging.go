package main

import (
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
)

// Redactor scrubs secrets from every log line before it reaches stderr (Electron writes
// stderr to <D>/logs/airbridge-net.log). It removes:
//   - the exact secrets of this run (auth key, control token, inbox token),
//   - anything shaped like a Tailscale/Headscale key,
//   - every URL (tsnet prints the interactive login URL when a node needs login; that URL
//     must never be logged or shown: AirBridge only enrolls with pre-auth keys).
type Redactor struct {
	mu      sync.Mutex
	secrets []string
}

var (
	keyLikeRe = regexp.MustCompile(`(?:hs|ts)key-[A-Za-z0-9_-]+`)
	urlRe     = regexp.MustCompile(`(?i)\bhttps?://[^\s"'<>]+`)
)

// Add registers an exact secret (ignored when shorter than 8 bytes).
func (r *Redactor) Add(secret string) {
	if len(secret) < 8 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.secrets = append(r.secrets, secret)
}

// Redact returns s without secrets, key-shaped strings or URLs.
func (r *Redactor) Redact(s string) string {
	r.mu.Lock()
	secrets := append([]string(nil), r.secrets...)
	r.mu.Unlock()
	for _, sec := range secrets {
		s = strings.ReplaceAll(s, sec, "<redacted>")
	}
	s = keyLikeRe.ReplaceAllString(s, "<redacted-key>")
	s = urlRe.ReplaceAllString(s, "<url>")
	return s
}

// Logger writes redacted, single-line messages to w (stderr), serialized.
type Logger struct {
	mu sync.Mutex
	w  io.Writer
	r  *Redactor
}

func newLogger(w io.Writer, r *Redactor) *Logger { return &Logger{w: w, r: r} }

// Logf matches tailscale.com/types/logger.Logf.
func (l *Logger) Logf(format string, args ...any) {
	msg := l.r.Redact(fmt.Sprintf(format, args...))
	msg = strings.ReplaceAll(strings.TrimRight(msg, "\n"), "\n", " | ")
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintln(l.w, "airbridge-net: "+msg)
}

// Raw writes one line without the prefix (the READY line).
func (l *Logger) Raw(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintln(l.w, line)
}

// Write lets the standard library logger (log.SetOutput) go through redaction too.
func (l *Logger) Write(p []byte) (int, error) {
	l.Logf("%s", string(p))
	return len(p), nil
}
