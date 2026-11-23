package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	// maxTaskBody matches the Python inbox's security.MAX_BODY_BYTES.
	maxTaskBody = 600_000
	// maxReplyBody caps what is relayed back from the inbox / a peer.
	maxReplyBody = 64 * 1024
	meshPort     = 8989

	headerSidecarTS    = "X-AirBridge-Sidecar-Ts"
	headerSidecarSig   = "X-AirBridge-Sidecar-Sig"
	headerPeerNode     = "X-AirBridge-Peer-Node"
	headerPeerIP       = "X-AirBridge-Peer-IP"
	headerPeerUser     = "X-AirBridge-Peer-User"
	headerSecret       = "X-AirBridge-Secret"

	meshMaxInFlight     = 16
	peerRequestsPerMin  = 30
	peerBurst           = 30
	meshRequestDeadline = 20 * time.Second
)

var peerNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// rateLimiter: token bucket per key (peer StableID).
type rateLimiter struct {
	mu      sync.Mutex
	perMin  float64
	burst   float64
	buckets map[string]*bucket
	now     func() time.Time
}

type bucket struct {
	tokens float64
	stamp  time.Time
}

func newRateLimiter(perMin, burst int) *rateLimiter {
	return &rateLimiter{perMin: float64(perMin), burst: float64(burst), buckets: map[string]*bucket{}, now: time.Now}
}

func (l *rateLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if len(l.buckets) > 4096 { // bounded memory: forget full buckets
		for k, b := range l.buckets {
			if now.Sub(b.stamp) > 2*time.Minute {
				delete(l.buckets, k)
			}
		}
	}
	b := l.buckets[key]
	if b == nil {
		b = &bucket{tokens: l.burst, stamp: now}
		l.buckets[key] = b
	}
	b.tokens += now.Sub(b.stamp).Minutes() * l.perMin
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.stamp = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, detail string) {
	writeJSON(w, status, map[string]string{"status": "error", "detail": detail})
}

// meshHandler serves the ONLY port this node exposes on the private network (:8989).
// POST /incoming_task: identify the sender with WhoIs on the live connection, require the
// same Headscale user as this node, rate-limit per peer, cap the body, then forward to the
// Python inbox on 127.0.0.1 with the sidecar token and the verified identity headers.
type meshHandler struct {
	be      netBackend
	inbox   *inboxTarget
	limiter *rateLimiter
	slots   chan struct{}
	client  *http.Client // loopback client to the inbox (no proxy, no redirects)
	logf    func(string, ...any)
	now     func() time.Time
}

// signForward is the HMAC-SHA256 (key = inbox token) over
// "AIRBRIDGE-FWD-1\n<METHOD>\n<path>\n<unix ts>\n<hex sha256(body)>\n<peer node>\n<peer ip>\n<peer user>".
// The Python inbox (airbridge_app/inbox.py verify_forward) recomputes it and allows ±60 s.
func signForward(key, method, path, ts string, body []byte, node, ip, user string) string {
	sum := sha256.Sum256(body)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("AIRBRIDGE-FWD-1\n" + method + "\n" + path + "\n" + ts + "\n" + hex.EncodeToString(sum[:]) +
		"\n" + node + "\n" + ip + "\n" + user))
	return hex.EncodeToString(mac.Sum(nil))
}

func newMeshHandler(be netBackend, inbox *inboxTarget, logf func(string, ...any)) *meshHandler {
	return &meshHandler{
		be:      be,
		inbox:   inbox,
		limiter: newRateLimiter(peerRequestsPerMin, peerBurst),
		slots:   make(chan struct{}, meshMaxInFlight),
		client:  loopbackClient(15 * time.Second),
		logf:    logf,
		now:     time.Now,
	}
}

func loopbackClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:   timeout,
		Transport: &http.Transport{Proxy: nil, MaxIdleConns: 4, IdleConnTimeout: 30 * time.Second},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func (m *meshHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/incoming_task" {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	select {
	case m.slots <- struct{}{}:
		defer func() { <-m.slots }()
	default:
		writeErr(w, http.StatusTooManyRequests, "too many requests, slow down")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), meshRequestDeadline)
	defer cancel()

	// 1. Who is on the other end of THIS connection (never cached by address).
	who, err := m.be.WhoIs(ctx, r.RemoteAddr)
	if err != nil || who == nil || who.Node == nil || who.UserProfile == nil {
		m.logf("mesh: rejected unidentified connection from %s", r.RemoteAddr)
		writeErr(w, http.StatusForbidden, "forbidden: unknown_peer")
		return
	}
	self, err := m.be.Status(ctx, false)
	if err != nil || self == nil || self.Self == nil || self.Self.UserID == 0 {
		writeErr(w, http.StatusServiceUnavailable, "network not ready")
		return
	}
	// 2. Same customer only (autogroup:self is the first layer; this is the second).
	if who.UserProfile.ID != self.Self.UserID || who.Node.User != self.Self.UserID {
		m.logf("mesh: rejected peer of another user from %s", r.RemoteAddr)
		writeErr(w, http.StatusForbidden, "forbidden: foreign_user")
		return
	}
	// Control-assigned name only (never the peer-asserted Hostinfo.Hostname).
	name := nodeLabel(who.Node.Name)
	if !peerNameRe.MatchString(name) {
		writeErr(w, http.StatusForbidden, "forbidden: bad_whois")
		return
	}
	ip := firstV4Prefix(who.Node.Addresses)
	// 3. Per-peer rate limit, before reading the body.
	if !m.limiter.allow(string(who.Node.StableID) + "|" + name) {
		writeErr(w, http.StatusTooManyRequests, "too many requests, slow down")
		return
	}
	// 4. Size cap (declared, then actual).
	if r.ContentLength > maxTaskBody {
		writeErr(w, http.StatusRequestEntityTooLarge, "payload too large (max "+strconv.Itoa(maxTaskBody)+" bytes)")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxTaskBody+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "could not read body")
		return
	}
	if len(body) > maxTaskBody {
		writeErr(w, http.StatusRequestEntityTooLarge, "payload too large (max "+strconv.Itoa(maxTaskBody)+" bytes)")
		return
	}
	// 5. Forward to the Python inbox with the verified identity.
	port, token := m.inbox.get()
	if port == 0 || token == "" {
		writeErr(w, http.StatusServiceUnavailable, "AirBridge is not ready to receive tasks on this device")
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"http://127.0.0.1:"+strconv.Itoa(port)+"/incoming_task", bytes.NewReader(body))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	user := strconv.FormatInt(int64(who.UserProfile.ID), 10)
	ts := strconv.FormatInt(m.now().Unix(), 10)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerPeerNode, name)
	if ip != "" {
		req.Header.Set(headerPeerIP, ip)
	}
	req.Header.Set(headerPeerUser, user)
	// S-2: the inbox token is never sent. Each forward is HMAC-signed with it, bound to this exact
	// request (method, path, time, body, verified identity), so whatever listens on the port learns
	// nothing it could replay elsewhere or later.
	req.Header.Set(headerSidecarTS, ts)
	req.Header.Set(headerSidecarSig, signForward(token, http.MethodPost, "/incoming_task", ts, body, name, ip, user))
	if s := r.Header.Get(headerSecret); s != "" && len(s) <= 1024 {
		req.Header.Set(headerSecret, s)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		// S-2: a registration whose port no longer answers is stale (daemon gone); forget it so a
		// process that later binds that port never receives forwarded tasks.
		if m.inbox.clearIf(port) {
			m.logf("mesh: inbox unreachable; registration cleared until the engine registers again")
		} else {
			m.logf("mesh: inbox unreachable")
		}
		writeErr(w, http.StatusServiceUnavailable, "AirBridge is not ready to receive tasks on this device")
		return
	}
	defer resp.Body.Close()
	reply, _ := io.ReadAll(io.LimitReader(resp.Body, maxReplyBody))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(reply)
	m.logf("mesh: task from %s relayed to inbox (HTTP %d)", name, resp.StatusCode)
}
