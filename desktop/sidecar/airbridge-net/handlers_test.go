package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

const (
	testToken = "ctl-token-0123456789abcdefghijklmnopqrstuv"
	inboxTok  = "inbox-token-0123456789abcdefghijklmnopqrstu"
	ctlHost   = "[::1]:4242"
)

// fakeBackend: self is user 7 (100.64.0.1); peers a2 (user 7, online), a3 (user 7, offline),
// b1 (user 9, online). WhoIs answers by remote IP.
type fakeBackend struct {
	mu        sync.Mutex
	whois     map[string]*apitype.WhoIsResponse
	whoCalls  []string
	state     string
	loggedOut bool
}

func peer(name string, uid tailcfg.UserID, ip string, online bool) *ipnstate.PeerStatus {
	return &ipnstate.PeerStatus{
		HostName: "airbridge-" + name, DNSName: "airbridge-" + name + ".", OS: "linux", UserID: uid,
		TailscaleIPs: []netip.Addr{netip.MustParseAddr(ip)}, Online: online,
		LastSeen: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
	}
}

func newFake() *fakeBackend {
	who := func(name string, uid tailcfg.UserID, ip string) *apitype.WhoIsResponse {
		return &apitype.WhoIsResponse{
			Node: &tailcfg.Node{Name: "airbridge-" + name + ".", User: uid, StableID: tailcfg.StableNodeID("n-" + name),
				Addresses: []netip.Prefix{netip.MustParsePrefix(ip + "/32")}},
			UserProfile: &tailcfg.UserProfile{ID: uid},
		}
	}
	return &fakeBackend{
		state: "Running",
		whois: map[string]*apitype.WhoIsResponse{
			"100.64.0.2": who("a2", 7, "100.64.0.2"),
			"100.64.0.9": who("b1", 9, "100.64.0.9"),
		},
	}
}

func (f *fakeBackend) Status(_ context.Context, peers bool) (*ipnstate.Status, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	st := &ipnstate.Status{BackendState: f.state, Self: peer("a1", 7, "100.64.0.1", true),
		AuthURL: "https://hs.example.com/register/SECRET-LOGIN-URL"}
	if peers {
		st.Peer = map[key.NodePublic]*ipnstate.PeerStatus{
			key.NewNode().Public(): peer("a2", 7, "100.64.0.2", true),
			key.NewNode().Public(): peer("a3", 7, "100.64.0.3", false),
			key.NewNode().Public(): peer("b1", 9, "100.64.0.9", true),
		}
	}
	return st, nil
}

func (f *fakeBackend) WhoIs(_ context.Context, remote string) (*apitype.WhoIsResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.whoCalls = append(f.whoCalls, remote)
	host := remote[:strings.LastIndexByte(remote, ':')]
	if w, ok := f.whois[host]; ok {
		return w, nil
	}
	return nil, errors.New("peer not found")
}

func (f *fakeBackend) Logout(context.Context) error {
	f.mu.Lock()
	f.loggedOut = true
	f.mu.Unlock()
	return nil
}

type postCall struct {
	ip   string
	body []byte
	hdr  http.Header
}

func newAPI(be netBackend) (*controlAPI, *[]postCall) {
	calls := &[]postCall{}
	api := &controlAPI{
		bearer: []byte("Bearer " + testToken),
		be:     func() netBackend { return be },
		post: func(_ context.Context, ip string, body []byte, hdr http.Header) (int, []byte, error) {
			*calls = append(*calls, postCall{ip, body, hdr})
			return 201, []byte(`{"status":"ok","file":"x.md"}`), nil
		},
		inbox:    &inboxTarget{},
		startErr: func() string { return "" },
		logf:     func(string, ...any) {},
	}
	api.setHost(ctlHost)
	return api, calls
}

func ctlReq(method, path, body string, mod func(*http.Request)) *http.Request {
	r := httptest.NewRequest(method, "http://"+ctlHost+path, strings.NewReader(body))
	r.Host = ctlHost
	r.RemoteAddr = "[::1]:50000"
	r.Header.Set("Authorization", "Bearer "+testToken)
	if mod != nil {
		mod(r)
	}
	return r
}

func do(h http.Handler, r *http.Request) (*httptest.ResponseRecorder, map[string]any) {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var m map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &m)
	return w, m
}

// ---------------------------------------------------------------- control API guard

func TestControlAuth(t *testing.T) {
	api, _ := newAPI(newFake())
	cases := []struct {
		name string
		mod  func(*http.Request)
		want int
	}{
		{"ok", nil, 200},
		{"no token", func(r *http.Request) { r.Header.Del("Authorization") }, 401},
		{"wrong token", func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+testToken+"x") }, 401},
		{"basic scheme", func(r *http.Request) { r.Header.Set("Authorization", "Basic "+testToken) }, 401},
		{"origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, 403},
		{"empty origin", func(r *http.Request) { r.Header["Origin"] = []string{""} }, 403},
		{"null origin no token", func(r *http.Request) { r.Header.Set("Origin", "null"); r.Header.Del("Authorization") }, 403},
		{"bad host", func(r *http.Request) { r.Host = "evil.example:4242" }, 403},
		{"localhost host", func(r *http.Request) { r.Host = "localhost:4242" }, 403},
		{"wrong port host", func(r *http.Request) { r.Host = "[::1]:4243" }, 403},
		{"non-loopback client", func(r *http.Request) { r.RemoteAddr = "100.64.0.2:1234" }, 403},
	}
	for _, tc := range cases {
		w, _ := do(api, ctlReq("GET", "/status", "", tc.mod))
		if w.Code != tc.want {
			t.Errorf("%s: got %d want %d", tc.name, w.Code, tc.want)
		}
	}
}

func TestStatusNeverLeaksLoginURL(t *testing.T) {
	f := newFake()
	f.state = "NeedsLogin"
	api, _ := newAPI(f)
	w, m := do(api, ctlReq("GET", "/status", "", nil))
	if w.Code != 200 || m["state"] != "needs_login" {
		t.Fatalf("got %d %v", w.Code, m)
	}
	if strings.Contains(w.Body.String(), "SECRET-LOGIN-URL") || strings.Contains(w.Body.String(), "http") {
		t.Fatalf("login URL leaked: %s", w.Body.String())
	}
}

func TestStatusConnected(t *testing.T) {
	api, _ := newAPI(newFake())
	_, m := do(api, ctlReq("GET", "/status", "", nil))
	self := m["self"].(map[string]any)
	if m["state"] != "connected" || self["hostname"] != "a1" || self["ip"] != "100.64.0.1" || self["user_id"] != float64(7) {
		t.Fatalf("status %v", m)
	}
}

func TestLoginOnlyBackend(t *testing.T) {
	api, _ := newAPI(loginOnlyBackend{})
	_, m := do(api, ctlReq("GET", "/status", "", nil))
	if m["state"] != "needs_login" {
		t.Fatalf("%v", m)
	}
}

func TestNodesSameUserOnlyPrefixStripped(t *testing.T) {
	api, _ := newAPI(newFake())
	_, m := do(api, ctlReq("GET", "/nodes", "", nil))
	nodes := m["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("want a2+a3 only, got %v", nodes)
	}
	first := nodes[0].(map[string]any)
	second := nodes[1].(map[string]any)
	if first["hostname"] != "a2" || first["online"] != true || second["hostname"] != "a3" || second["online"] != false {
		t.Fatalf("nodes %v", nodes)
	}
	if second["last_seen"] == nil || first["last_seen"] != nil {
		t.Fatalf("last_seen %v", nodes)
	}
}

// ---------------------------------------------------------------- /send

func sendBody(target string) string {
	b, _ := json.Marshal(map[string]any{"target_hostname": target,
		"payload": map[string]any{"sender_node": "a1", "task_description": "hi"}})
	return string(b)
}

func TestSendResolvesHostnameOnly(t *testing.T) {
	api, calls := newAPI(newFake())
	for _, target := range []string{"a2", "A2", "airbridge-a2"} {
		w, m := do(api, ctlReq("POST", "/send", sendBody(target), nil))
		if w.Code != 200 || m["status"] != float64(201) || m["ok"] != true {
			t.Fatalf("%s: %d %v", target, w.Code, m)
		}
	}
	if len(*calls) != 3 || (*calls)[0].ip != "100.64.0.2" {
		t.Fatalf("calls %+v", *calls)
	}
	cases := map[string]int{
		"100.64.0.2":   400, // raw IPs are never accepted
		"[fd7a::1]":    400,
		"::1":          400,
		"b1":           404, // other user's node
		"a3":           404, // offline
		"a1":           404, // self
		"nope":         404,
		"a2/../x":      400,
		"a2:8080":      400,
		"":             400,
		"127.0.0.1":    400,
		"evil.example": 404,
	}
	for target, want := range cases {
		w, _ := do(api, ctlReq("POST", "/send", sendBody(target), nil))
		if w.Code != want {
			t.Errorf("target %q: got %d want %d", target, w.Code, want)
		}
	}
	if len(*calls) != 3 {
		t.Fatalf("refused targets must not be dialed: %d calls", len(*calls))
	}
}

func TestSendRejectsUnknownFieldsAndBadPayload(t *testing.T) {
	api, calls := newAPI(newFake())
	for _, body := range []string{
		`{"target_hostname":"a2","payload":{},"target_ip":"100.64.0.2"}`,
		`{"target_hostname":"a2","payload":"text"}`,
		`{"target_hostname":"a2"}`,
		`not json`,
	} {
		w, _ := do(api, ctlReq("POST", "/send", body, nil))
		if w.Code != 400 {
			t.Errorf("%s: got %d", body, w.Code)
		}
	}
	if len(*calls) != 0 {
		t.Fatal("dialed on a bad request")
	}
}

func TestSendBodyCap(t *testing.T) {
	api, calls := newAPI(newFake())
	big := `{"target_hostname":"a2","payload":{"task_description":"` + strings.Repeat("x", maxTaskBody) + `"}}`
	w, _ := do(api, ctlReq("POST", "/send", big, nil))
	if w.Code != 413 || len(*calls) != 0 {
		t.Fatalf("got %d calls %d", w.Code, len(*calls))
	}
	huge := strings.Repeat("x", maxSendRequest+10)
	w, _ = do(api, ctlReq("POST", "/send", huge, nil))
	if w.Code != 413 {
		t.Fatalf("huge: %d", w.Code)
	}
}

func TestSendForwardsSecretAndReportsUnreachable(t *testing.T) {
	api, calls := newAPI(newFake())
	body := `{"target_hostname":"a2","payload":{"x":1},"secret":"s3cret-value"}`
	do(api, ctlReq("POST", "/send", body, nil))
	if (*calls)[0].hdr.Get(headerSecret) != "s3cret-value" {
		t.Fatal("secret not forwarded")
	}
	api.post = func(context.Context, string, []byte, http.Header) (int, []byte, error) {
		return 0, nil, errors.New("dial tcp: connection refused")
	}
	w, m := do(api, ctlReq("POST", "/send", sendBody("a2"), nil))
	if w.Code != 502 || m["error"] != "unreachable" {
		t.Fatalf("%d %v", w.Code, m)
	}
}

func TestSendNotConnected(t *testing.T) {
	f := newFake()
	f.state = "NeedsLogin"
	api, calls := newAPI(f)
	w, _ := do(api, ctlReq("POST", "/send", sendBody("a2"), nil))
	if w.Code != 503 || len(*calls) != 0 {
		t.Fatalf("%d", w.Code)
	}
}

func TestInboxRegistrationAndLogout(t *testing.T) {
	f := newFake()
	api, _ := newAPI(f)
	for _, b := range []string{`{"port":0,"token":"` + inboxTok + `"}`, `{"port":1234,"token":"short"}`, `{"port":1234}`} {
		if w, _ := do(api, ctlReq("POST", "/inbox", b, nil)); w.Code != 400 {
			t.Errorf("%s: %d", b, w.Code)
		}
	}
	if w, _ := do(api, ctlReq("POST", "/inbox", `{"port":1234,"token":"`+inboxTok+`"}`, nil)); w.Code != 200 {
		t.Fatal("register failed")
	}
	if p, tok := api.inbox.get(); p != 1234 || tok != inboxTok {
		t.Fatal("not stored")
	}
	if w, _ := do(api, ctlReq("POST", "/logout", "", nil)); w.Code != 200 || !f.loggedOut {
		t.Fatal("logout")
	}
	if w, _ := do(api, ctlReq("GET", "/logout", "", nil)); w.Code != 404 {
		t.Fatal("GET logout must 404")
	}
}

// ---------------------------------------------------------------- mesh handler

type inboxRec struct {
	mu   sync.Mutex
	hdrs []http.Header
	n    int
}

func newInbox(t *testing.T, mh *meshHandler) *inboxRec {
	rec := &inboxRec{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		rec.mu.Lock()
		rec.hdrs = append(rec.hdrs, r.Header.Clone())
		rec.n++
		rec.mu.Unlock()
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"status":"ok","file":"t.md"}`))
	}))
	t.Cleanup(srv.Close)
	port, _ := strconv.Atoi(srv.URL[strings.LastIndexByte(srv.URL, ':')+1:])
	mh.inbox.set(port, inboxTok)
	return rec
}

func meshReq(remote string, body []byte) *http.Request {
	r := httptest.NewRequest("POST", "http://100.64.0.1:8989/incoming_task", bytes.NewReader(body))
	r.RemoteAddr = remote
	r.Header.Set("X-AirBridge-Peer-Node", "spoofed")
	return r
}

func TestMeshSameUserForwardedWithVerifiedIdentity(t *testing.T) {
	f := newFake()
	mh := newMeshHandler(f, &inboxTarget{}, func(string, ...any) {})
	rec := newInbox(t, mh)
	r := meshReq("100.64.0.2:41000", []byte(`{"sender_node":"liar","task_description":"x"}`))
	r.Header.Set(headerSecret, "shh")
	r.Header.Set(headerSidecarToken, "attacker-chosen")
	w, _ := do(mh, r)
	if w.Code != 201 || rec.n != 1 {
		t.Fatalf("got %d (%s) inbox=%d", w.Code, w.Body.String(), rec.n)
	}
	h := rec.hdrs[0]
	if h.Get(headerSidecarToken) != inboxTok || h.Get(headerPeerNode) != "airbridge-a2" ||
		h.Get(headerPeerIP) != "100.64.0.2" || h.Get(headerPeerUser) != "7" || h.Get(headerSecret) != "shh" {
		t.Fatalf("headers %v", h)
	}
	if f.whoCalls[0] != "100.64.0.2:41000" {
		t.Fatalf("whois must use the live RemoteAddr, got %v", f.whoCalls)
	}
}

func TestMeshRejectsForeignAndUnknown(t *testing.T) {
	f := newFake()
	mh := newMeshHandler(f, &inboxTarget{}, func(string, ...any) {})
	rec := newInbox(t, mh)
	for remote, want := range map[string]string{
		"100.64.0.9:1000": "foreign_user", // user B
		"100.64.0.5:1000": "unknown_peer", // whois miss
		"127.0.0.1:1000":  "unknown_peer",
	} {
		w, m := do(mh, meshReq(remote, []byte(`{}`)))
		if w.Code != 403 || !strings.Contains(m["detail"].(string), want) {
			t.Errorf("%s: %d %v", remote, w.Code, m)
		}
	}
	// whois claims same profile id but the node belongs to someone else: still refused.
	f.whois["100.64.0.6"] = &apitype.WhoIsResponse{
		Node:        &tailcfg.Node{Name: "airbridge-x.", User: 9, Addresses: []netip.Prefix{netip.MustParsePrefix("100.64.0.6/32")}},
		UserProfile: &tailcfg.UserProfile{ID: 7},
	}
	if w, _ := do(mh, meshReq("100.64.0.6:1", []byte(`{}`))); w.Code != 403 {
		t.Errorf("mismatched node user: %d", w.Code)
	}
	if rec.n != 0 {
		t.Fatal("refused requests reached the inbox")
	}
}

func TestMeshBodyCapAndRoutes(t *testing.T) {
	f := newFake()
	mh := newMeshHandler(f, &inboxTarget{}, func(string, ...any) {})
	rec := newInbox(t, mh)
	w, _ := do(mh, meshReq("100.64.0.2:1", bytes.Repeat([]byte("x"), maxTaskBody+1)))
	if w.Code != 413 {
		t.Fatalf("declared: %d", w.Code)
	}
	r := meshReq("100.64.0.2:1", bytes.Repeat([]byte("x"), maxTaskBody+1))
	r.ContentLength = -1 // chunked: actual size enforced
	if w, _ := do(mh, r); w.Code != 413 {
		t.Fatalf("actual: %d", w.Code)
	}
	r = httptest.NewRequest("POST", "http://x/other", nil)
	r.RemoteAddr = "100.64.0.2:1"
	if w, _ := do(mh, r); w.Code != 404 {
		t.Fatal("other path")
	}
	r = httptest.NewRequest("GET", "http://x/incoming_task", nil)
	r.RemoteAddr = "100.64.0.2:1"
	if w, _ := do(mh, r); w.Code != 405 {
		t.Fatal("GET")
	}
	if rec.n != 0 {
		t.Fatal("inbox reached")
	}
}

func TestMeshNoInboxRegistered(t *testing.T) {
	mh := newMeshHandler(newFake(), &inboxTarget{}, func(string, ...any) {})
	if w, _ := do(mh, meshReq("100.64.0.2:1", []byte(`{}`))); w.Code != 503 {
		t.Fatalf("%d", w.Code)
	}
}

func TestMeshRateLimitPerPeer(t *testing.T) {
	mh := newMeshHandler(newFake(), &inboxTarget{}, func(string, ...any) {})
	newInbox(t, mh)
	now := time.Unix(1000, 0)
	mh.limiter.now = func() time.Time { return now }
	for i := 0; i < peerBurst; i++ {
		if w, _ := do(mh, meshReq("100.64.0.2:1", []byte(`{}`))); w.Code != 201 {
			t.Fatalf("req %d: %d", i, w.Code)
		}
	}
	if w, _ := do(mh, meshReq("100.64.0.2:1", []byte(`{}`))); w.Code != 429 {
		t.Fatalf("want 429, got %d", w.Code)
	}
	now = now.Add(10 * time.Second) // 30/min -> 5 tokens
	if w, _ := do(mh, meshReq("100.64.0.2:1", []byte(`{}`))); w.Code != 201 {
		t.Fatalf("refill: %d", w.Code)
	}
}

// ---------------------------------------------------------------- config + logging

func TestConfigValidation(t *testing.T) {
	good := `{"control_url":"https://hs.example.com","hostname":"airbridge-a1","control_token":"` + testToken + `","state_dir":"/tmp/x"}`
	if _, err := readConfig(strings.NewReader(good + "\n")); err != nil {
		t.Fatal(err)
	}
	bad := []string{
		``,
		`{"control_url":"http://hs.example.com","hostname":"airbridge-a1","control_token":"` + testToken + `","state_dir":"/tmp/x"}`,
		`{"control_url":"https://hs.example.com","hostname":"a1","control_token":"` + testToken + `","state_dir":"/tmp/x"}`,
		`{"control_url":"https://hs.example.com","hostname":"airbridge-a1","control_token":"short","state_dir":"/tmp/x"}`,
		`{"control_url":"https://hs.example.com","hostname":"airbridge-a1","control_token":"` + testToken + `","state_dir":"rel"}`,
		`{"control_url":"https://hs.example.com","hostname":"airbridge-a1","control_token":"` + testToken + `","state_dir":"/tmp/x","client_secret":"x"}`,
		`{"control_url":"https://hs.example.com","hostname":"airbridge-a1","control_token":"` + testToken + `","state_dir":"/tmp/x","inbox_url":"http://10.0.0.1:80","inbox_token":"` + inboxTok + `"}`,
		strings.Repeat("x", maxConfigBytes+10),
	}
	for _, b := range bad {
		if _, err := readConfig(strings.NewReader(b)); err == nil {
			t.Errorf("accepted %.80s", b)
		}
	}
	if _, err := readConfig(strings.NewReader(strings.Replace(good, "https://hs.example.com", "http://127.0.0.1:8080", 1))); err != nil {
		t.Errorf("localhost http control url refused: %v", err)
	}
}

func TestRedaction(t *testing.T) {
	r := &Redactor{}
	r.Add("hskey-auth-abcdef0123456789")
	r.Add(testToken)
	out := r.Redact("key hskey-auth-abcdef0123456789 tok " + testToken + " go to: https://hs.example.com/register/nodekey:abc tskey-auth-k1-xyz")
	for _, leak := range []string{"hskey-auth-abc", testToken, "register", "tskey-auth-k1", "https://"} {
		if strings.Contains(out, leak) {
			t.Fatalf("leak %q in %q", leak, out)
		}
	}
	var buf bytes.Buffer
	lg := newLogger(&buf, r)
	lg.Logf("To start this tsnet server, restart with TS_AUTHKEY set, or go to: %s", "http://127.0.0.1:1/register/xyz")
	if strings.Contains(buf.String(), "register") {
		t.Fatal(buf.String())
	}
}

func TestNetState(t *testing.T) {
	cases := map[string]string{"NeedsLogin": "needs_login", "Stopped": "needs_login", "NoState": "connecting",
		"Starting": "connecting", "NeedsMachineAuth": "connecting"}
	for in, want := range cases {
		if got := netState(&ipnstate.Status{BackendState: in}, ""); got != want {
			t.Errorf("%s: %s", in, got)
		}
	}
	if netState(&ipnstate.Status{BackendState: "Running"}, "boom") != "error" {
		t.Error("startErr")
	}
}
