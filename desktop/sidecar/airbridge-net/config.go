package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// maxConfigBytes bounds the single JSON line Electron writes on stdin.
const maxConfigBytes = 64 * 1024

// Config is the one JSON line read from stdin at spawn (PHASE3_PLAN.md §9).
// Secrets (auth key, tokens) only ever arrive here: never argv, never env.
type Config struct {
	// AuthKey is a single-use Headscale pre-auth key. Only sent when /status said
	// needs_login; ignored by tsnet when the state dir already holds a node.
	AuthKey string `json:"auth_key,omitempty"`
	// ControlURL is the Headscale server (https; http only for localhost).
	ControlURL string `json:"control_url"`
	// Hostname is "airbridge-<[a-z0-9-] ≤50>".
	Hostname string `json:"hostname"`
	// ControlToken is the bearer for the local control API.
	ControlToken string `json:"control_token"`
	// InboxURL / InboxToken: the Python inbox (http://127.0.0.1:<port>) and its
	// X-AirBridge-Sidecar-Token. Optional: the daemon normally registers its
	// inbox itself with POST /inbox (it binds an ephemeral port after spawn).
	InboxURL   string `json:"inbox_url,omitempty"`
	InboxToken string `json:"inbox_token,omitempty"`
	// StateDir is <D>/tsnet (created 0700).
	StateDir string `json:"state_dir"`
	// ParentPID: exit when this process is gone (Electron crash). Optional.
	ParentPID int `json:"parent_pid,omitempty"`
	// Verbose forwards tsnet's backend logs (redacted) to stderr.
	Verbose bool `json:"verbose,omitempty"`
}

var (
	hostnameRe = regexp.MustCompile(`^airbridge-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$`)
	tokenRe    = regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`)
	authKeyRe  = regexp.MustCompile(`^[A-Za-z0-9_-]{16,512}$`)
)

// readConfig reads exactly one line (≤ maxConfigBytes) from r.
func readConfig(r io.Reader) (*Config, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 4096), maxConfigBytes)
	if !sc.Scan() {
		if errors.Is(sc.Err(), bufio.ErrTooLong) {
			return nil, errors.New("configuration too large")
		}
		return nil, errors.New("missing configuration on stdin")
	}
	var c Config
	dec := json.NewDecoder(bytes.NewReader(sc.Bytes()))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return nil, errors.New("configuration is not valid JSON")
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) validate() error {
	if _, err := validateControlURL(c.ControlURL); err != nil {
		return err
	}
	if !hostnameRe.MatchString(c.Hostname) {
		return errors.New("invalid hostname")
	}
	if !tokenRe.MatchString(c.ControlToken) {
		return errors.New("invalid control_token")
	}
	if c.AuthKey != "" && !authKeyRe.MatchString(c.AuthKey) {
		return errors.New("invalid auth_key")
	}
	if c.StateDir == "" || !filepath.IsAbs(c.StateDir) || strings.ContainsRune(c.StateDir, 0) {
		return errors.New("state_dir must be an absolute path")
	}
	if (c.InboxURL == "") != (c.InboxToken == "") {
		return errors.New("inbox_url and inbox_token go together")
	}
	if c.InboxURL != "" {
		if _, err := inboxPortFromURL(c.InboxURL); err != nil {
			return err
		}
		if !tokenRe.MatchString(c.InboxToken) {
			return errors.New("invalid inbox_token")
		}
	}
	if c.ParentPID < 0 {
		return errors.New("invalid parent_pid")
	}
	return nil
}

// validateControlURL: https, or http only for localhost/loopback (tests, local Headscale).
// No credentials, query or fragment.
func validateControlURL(raw string) (string, error) {
	if raw == "" || len(raw) > 2048 {
		return "", errors.New("invalid control_url")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("invalid control_url")
	}
	h := u.Hostname()
	local := h == "localhost" || h == "127.0.0.1" || h == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return "", errors.New("control_url must be https")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

// inboxPortFromURL accepts exactly http://127.0.0.1:<port> (optional trailing slash).
func inboxPortFromURL(raw string) (int, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return 0, errors.New("inbox_url must be http://127.0.0.1:<port>")
	}
	p, err := strconv.Atoi(u.Port())
	if err != nil || p < 1 || p > 65535 {
		return 0, fmt.Errorf("inbox_url must be http://127.0.0.1:<port>")
	}
	return p, nil
}
