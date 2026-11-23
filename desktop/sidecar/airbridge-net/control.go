package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn/ipnstate"
)

const (
	maxSendRequest = maxTaskBody + 8*1024
	sendTimeout    = 10 * time.Second
)

// peerPoster delivers a task body to http://<peerIP>:8989/incoming_task over the private
// network (tsnet.Server.HTTPClient in production, an in-process fake in tests).
type peerPoster func(ctx context.Context, peerIP string, body []byte, hdr http.Header) (int, []byte, error)

// controlAPI is the local control API (Electron, the daemon and the MCP stdio process).
// Bound to [::1] (fallback 127.0.0.1) on an ephemeral port. Every request must:
//  1. come from loopback and carry no Origin header (browsers always send one) -> 403
//  2. have Host exactly "[::1]:<port>" / "127.0.0.1:<port>" (anti DNS-rebinding)  -> 403
//  3. carry "Authorization: Bearer <control_token>" (constant-time compare)      -> 401
type controlAPI struct {
	bearer   []byte
	hostMu   sync.Mutex
	host     string // expected Host header, set once listening
	be       func() netBackend
	post     peerPoster
	inbox    *inboxTarget
	startErr func() string
	onLogout func()
	logf     func(string, ...any)
}

func (c *controlAPI) setHost(h string) {
	c.hostMu.Lock()
	c.host = h
	c.hostMu.Unlock()
}

func (c *controlAPI) expectedHost() string {
	c.hostMu.Lock()
	defer c.hostMu.Unlock()
	return c.host
}

func isLoopbackRemote(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return false
	}
	ip, err := netip.ParseAddr(host)
	return err == nil && ip.Unmap().IsLoopback()
}

func (c *controlAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackRemote(r.RemoteAddr) {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "forbidden: loopback only"})
		return
	}
	if _, ok := r.Header["Origin"]; ok {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "forbidden: browser origins are not allowed"})
		return
	}
	if want := c.expectedHost(); want == "" || r.Host != want {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "forbidden: bad host"})
		return
	}
	got := []byte(r.Header.Get("Authorization"))
	if subtle.ConstantTimeCompare(got, c.bearer) != 1 {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	switch {
	case r.URL.Path == "/status" && r.Method == http.MethodGet:
		c.status(w, r)
	case r.URL.Path == "/nodes" && r.Method == http.MethodGet:
		c.nodes(w, r)
	case r.URL.Path == "/send" && r.Method == http.MethodPost:
		c.send(w, r)
	case r.URL.Path == "/inbox" && r.Method == http.MethodPost:
		c.registerInbox(w, r)
	case r.URL.Path == "/logout" && r.Method == http.MethodPost:
		c.logout(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not found"})
	}
}

func (c *controlAPI) status(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	startErr := c.startErr()
	port, _ := c.inbox.get()
	resp := map[string]any{"inbox_registered": port != 0}
	if startErr != "" {
		resp["state"], resp["self"], resp["error"] = "error", selfInfo{}, startErr
		writeJSON(w, http.StatusOK, resp)
		return
	}
	st, err := c.be().Status(ctx, false)
	if err != nil {
		resp["state"], resp["self"] = "connecting", selfInfo{}
		writeJSON(w, http.StatusOK, resp)
		return
	}
	// Never relay st.AuthURL: AirBridge enrolls with pre-auth keys only.
	resp["state"], resp["self"] = netState(st, ""), selfOf(st)
	writeJSON(w, http.StatusOK, resp)
}

func (c *controlAPI) nodes(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if e := c.startErr(); e != "" {
		writeJSON(w, http.StatusOK, map[string]any{"self": selfInfo{}, "nodes": []nodeInfo{}, "state": "error", "error": e})
		return
	}
	st, err := c.be().Status(ctx, true)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"self": selfInfo{}, "nodes": []nodeInfo{}, "state": "connecting"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"self":  selfOf(st),
		"nodes": sameUserPeers(st),
		"state": netState(st, ""),
	})
}

type sendRequest struct {
	TargetHostname string          `json:"target_hostname"`
	Payload        json.RawMessage `json:"payload"`
	Secret         string          `json:"secret,omitempty"`
}

// send: POST /send {target_hostname, payload[, secret]} -> {status, body}.
// target_hostname is resolved against the CURRENT online peers of this user only; raw IPs
// (or anything that is not a peer name) are refused, so the control API cannot be turned
// into a generic proxy into the private network.
func (c *controlAPI) send(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength > maxSendRequest {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"ok": false, "error": "payload_too_large"})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxSendRequest+1))
	if err != nil || len(raw) > maxSendRequest {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"ok": false, "error": "payload_too_large"})
		return
	}
	var req sendRequest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_request"})
		return
	}
	target := strings.TrimSuffix(strings.TrimSpace(req.TargetHostname), ".")
	if _, ipErr := netip.ParseAddr(strings.Trim(target, "[]")); ipErr == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "hostname_required"})
		return
	}
	if !peerNameRe.MatchString(target) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_target"})
		return
	}
	payload := bytes.TrimSpace(req.Payload)
	if len(payload) == 0 || payload[0] != '{' || !json.Valid(payload) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_payload"})
		return
	}
	if len(payload) > maxTaskBody {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"ok": false, "error": "payload_too_large"})
		return
	}
	if len(req.Secret) > 1024 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_request"})
		return
	}
	if e := c.startErr(); e != "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "network_unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), sendTimeout)
	defer cancel()
	st, err := c.be().Status(ctx, true)
	if err != nil || netState(st, "") != "connected" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "not_connected"})
		return
	}
	ip := resolvePeer(st, target)
	if ip == "" {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "unknown_target"})
		return
	}
	hdr := http.Header{}
	hdr.Set("Content-Type", "application/json")
	if req.Secret != "" {
		hdr.Set(headerSecret, req.Secret)
	}
	status, body, err := c.post(ctx, ip, payload, hdr)
	if err != nil {
		code, what := http.StatusBadGateway, "unreachable"
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code, what = http.StatusGatewayTimeout, "timeout"
		}
		c.logf("send: delivery to %s failed: %s", target, what)
		writeJSON(w, code, map[string]any{"ok": false, "error": what, "target": target})
		return
	}
	c.logf("send: delivered to %s (HTTP %d)", target, status)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": status, "body": string(body), "target": target})
}

// resolvePeer: exact (case-insensitive) name match among ONLINE same-user peers, with or
// without the airbridge- prefix. Returns the peer's tailnet IPv4 or "".
func resolvePeer(st *ipnstate.Status, target string) string {
	want := strings.ToLower(stripPrefix(target))
	for _, n := range sameUserPeers(st) {
		if n.Online && n.Hostname == want {
			return n.IP
		}
	}
	return ""
}

func (c *controlAPI) registerInbox(w http.ResponseWriter, r *http.Request) {
	// {port, token} registers; {port: 0[, if_port: P]} deregisters (S-2: the daemon does this on
	// shutdown; with if_port only if P is still the registered port, so a newer daemon is never undone).
	var req struct {
		Port   int    `json:"port"`
		Token  string `json:"token"`
		IfPort int    `json:"if_port"`
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 4096))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_request"})
		return
	}
	if req.Port == 0 && req.Token == "" {
		if req.IfPort != 0 {
			c.inbox.clearIf(req.IfPort)
		} else {
			c.inbox.set(0, "")
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	if req.Port < 1 || req.Port > 65535 || !tokenRe.MatchString(req.Token) || req.IfPort != 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_request"})
		return
	}
	c.inbox.set(req.Port, req.Token)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (c *controlAPI) logout(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if err := c.be().Logout(ctx); err != nil {
		c.logf("logout failed: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": "logout_failed"})
		return
	}
	if c.onLogout != nil {
		c.onLogout()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// expectedHostFor builds the Host header value for a bound address.
func expectedHostFor(addr net.Addr) string {
	ta, ok := addr.(*net.TCPAddr)
	if !ok {
		return ""
	}
	port := strconv.Itoa(ta.Port)
	if ta.IP.To4() == nil {
		return "[" + ta.IP.String() + "]:" + port
	}
	return ta.IP.String() + ":" + port
}
