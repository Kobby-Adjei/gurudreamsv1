package main

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
)

// netBackend is the slice of the tsnet LocalClient the handlers use (faked in tests).
type netBackend interface {
	// Status returns the node status; peers=false is the cheap variant.
	Status(ctx context.Context, peers bool) (*ipnstate.Status, error)
	// WhoIs identifies the tailnet peer behind remoteAddr ("ip:port" of a mesh connection).
	WhoIs(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error)
	Logout(ctx context.Context) error
}

// localBackend adapts *local.Client (in-process LocalAPI of the tsnet.Server).
type localBackend struct{ lc *local.Client }

func (b localBackend) Status(ctx context.Context, peers bool) (*ipnstate.Status, error) {
	if peers {
		return b.lc.Status(ctx)
	}
	return b.lc.StatusWithoutPeers(ctx)
}

func (b localBackend) WhoIs(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error) {
	// proto=tcp: only TCP flows can vouch for a TCP connection (PHASE3_SECURITY.md F-2).
	return b.lc.WhoIsProto(ctx, "tcp", remoteAddr)
}

func (b localBackend) Logout(ctx context.Context) error { return b.lc.Logout(ctx) }

// loginOnlyBackend is used when there is neither node state nor an auth key: tsnet is
// not started at all (no control-server contact, no interactive login URL), and the
// control API simply reports needs_login until Electron respawns us with a key.
type loginOnlyBackend struct{}

func (loginOnlyBackend) Status(context.Context, bool) (*ipnstate.Status, error) {
	return &ipnstate.Status{BackendState: "NeedsLogin"}, nil
}

func (loginOnlyBackend) WhoIs(context.Context, string) (*apitype.WhoIsResponse, error) {
	return nil, errors.New("not connected")
}

func (loginOnlyBackend) Logout(context.Context) error { return nil }

// ----------------------------------------------------------------------------------------
// Status mapping (shared by /status, /nodes, /send and the mesh handler)
// ----------------------------------------------------------------------------------------

const hostPrefix = "airbridge-"

// nodeLabel: "airbridge-a1.example.ts.net." -> "airbridge-a1" (first DNS label, no dot).
func nodeLabel(fqdn string) string {
	s := strings.TrimSuffix(strings.TrimSpace(fqdn), ".")
	if i := strings.IndexByte(s, '.'); i >= 0 {
		s = s[:i]
	}
	return s
}

// stripPrefix drops the airbridge- prefix (case-insensitive) when something follows it.
func stripPrefix(name string) string {
	if len(name) > len(hostPrefix) && strings.EqualFold(name[:len(hostPrefix)], hostPrefix) {
		return name[len(hostPrefix):]
	}
	return name
}

// displayName: control-assigned DNS label (what receivers verify via WhoIs), falling back to
// the self-reported HostName, airbridge- prefix stripped, lower-case.
func displayName(ps *ipnstate.PeerStatus) string {
	n := nodeLabel(ps.DNSName)
	if n == "" {
		n = strings.TrimSpace(ps.HostName)
	}
	return strings.ToLower(stripPrefix(n))
}

func firstV4(ips []netip.Addr) string {
	for _, ip := range ips {
		if ip.Is4() {
			return ip.String()
		}
	}
	return ""
}

func firstV4Prefix(pfx []netip.Prefix) string {
	for _, p := range pfx {
		if p.Addr().Is4() {
			return p.Addr().String()
		}
	}
	return ""
}

// netState maps ipn.State strings onto the contract's states.
func netState(st *ipnstate.Status, startErr string) string {
	if startErr != "" {
		return "error"
	}
	if st == nil {
		return "connecting"
	}
	switch st.BackendState {
	case "Running":
		if st.Self != nil && firstV4(st.Self.TailscaleIPs) != "" {
			return "connected"
		}
		return "connecting"
	case "NeedsLogin":
		return "needs_login"
	case "Stopped":
		// We always run with WantRunning=true; Stopped only follows a logout.
		return "needs_login"
	default: // NoState, Starting, NeedsMachineAuth
		return "connecting"
	}
}

type selfInfo struct {
	Hostname string `json:"hostname"`
	IP       string `json:"ip,omitempty"`
	UserID   int64  `json:"user_id,omitempty"`
	OS       string `json:"os,omitempty"`
}

func selfOf(st *ipnstate.Status) selfInfo {
	if st == nil || st.Self == nil {
		return selfInfo{}
	}
	return selfInfo{
		Hostname: displayName(st.Self),
		IP:       firstV4(st.Self.TailscaleIPs),
		UserID:   int64(st.Self.UserID),
		OS:       st.Self.OS,
	}
}

type nodeInfo struct {
	Hostname string  `json:"hostname"`
	IP       string  `json:"ip"`
	OS       string  `json:"os,omitempty"`
	Online   bool    `json:"online"`
	LastSeen *string `json:"last_seen"`
}

// sameUserPeers lists peers owned by Self's user only (autogroup:self already enforces
// this at the packet filter; this is the second layer).
func sameUserPeers(st *ipnstate.Status) []nodeInfo {
	out := []nodeInfo{}
	if st == nil || st.Self == nil || st.Self.UserID == 0 {
		return out
	}
	selfIPs := map[netip.Addr]bool{}
	for _, ip := range st.Self.TailscaleIPs {
		selfIPs[ip] = true
	}
	for _, ps := range st.Peer {
		if ps == nil || ps.UserID != st.Self.UserID {
			continue
		}
		ip := firstV4(ps.TailscaleIPs)
		name := displayName(ps)
		if ip == "" || name == "" || selfIPs[netip.MustParseAddr(ip)] {
			continue
		}
		n := nodeInfo{Hostname: name, IP: ip, OS: ps.OS, Online: ps.Online}
		if !ps.Online && !ps.LastSeen.IsZero() {
			ls := ps.LastSeen.UTC().Format(time.RFC3339)
			n.LastSeen = &ls
		}
		out = append(out, n)
	}
	sortNodes(out)
	return out
}

func sortNodes(n []nodeInfo) {
	// small n: insertion sort (online first, then name)
	less := func(a, b nodeInfo) bool {
		if a.Online != b.Online {
			return a.Online
		}
		return a.Hostname < b.Hostname
	}
	for i := 1; i < len(n); i++ {
		for j := i; j > 0 && less(n[j], n[j-1]); j-- {
			n[j], n[j-1] = n[j-1], n[j]
		}
	}
}

// inboxTarget is where verified mesh requests are forwarded (the Python inbox).
type inboxTarget struct {
	mu    sync.Mutex
	port  int
	token string
}

func (t *inboxTarget) set(port int, token string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.port, t.token = port, token
}

func (t *inboxTarget) get() (int, string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.port, t.token
}
