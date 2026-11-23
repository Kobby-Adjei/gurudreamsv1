// Command airbridge-net is AirBridge Pro's private-network sidecar (PHASE3_PLAN.md §9).
//
// It embeds tailscale.com/tsnet (no system Tailscale, no tailscaled, no TUN, no SOCKS) and
// joins the customer's self-hosted Headscale network. Spawned by the Electron app:
//
//	stdin:  ONE JSON line {auth_key?, control_url, hostname, control_token, inbox_url?,
//	        inbox_token?, state_dir, parent_pid?, verbose?}; stdin is closed after reading.
//	stderr: redacted log lines, plus exactly one
//	        AIRBRIDGE_NET_READY {"port":N,"pid":P,"host":"::1"|"127.0.0.1"}
//	        once the local control API listens.
//	stdout: never written.
//
// Exposed on the private network: tcp/8989 only (POST /incoming_task, WhoIs-verified,
// same-user only, forwarded to the Python inbox on 127.0.0.1). Locally: the control API
// (control.go). Tailscale log upload is disabled; nothing talks to Tailscale-operated hosts.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/envknob"
	"tailscale.com/logtail"
	"tailscale.com/tsnet"
)

const readyPrefix = "AIRBRIDGE_NET_READY"

// scrubTailscaleEnv clears EVERY TS_* / TSNET_* knob (S-5: an allowlist, not a denylist) except
// TS_NO_LOGS_NO_SUPPORT, through envknob.Setenv so knobs that tailscale.com packages already registered
// at init time are reset too. Credentials, control URLs, debug switches: none can steer tsnet behind
// our back. Electron's allowlist scrub is the first layer. One exception, for local test setups only:
// TS_DEBUG_USE_DERP_HTTP survives when the control server is plain http (which config.go permits only
// for loopback), because a local Headscale's embedded DERP has no TLS. Returns the names cleared.
func scrubTailscaleEnv(plainHTTPControl bool) []string {
	var cleared []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if !strings.HasPrefix(k, "TS_") && !strings.HasPrefix(k, "TSNET_") {
			continue
		}
		if k == "TS_NO_LOGS_NO_SUPPORT" || (k == "TS_DEBUG_USE_DERP_HTTP" && plainHTTPControl) {
			continue
		}
		envknob.Setenv(k, "")
		_ = os.Unsetenv(k)
		cleared = append(cleared, k)
	}
	return cleared
}

func main() {
	os.Exit(run())
}

func run() int {
	red := &Redactor{}
	lg := newLogger(os.Stderr, red)
	log.SetFlags(0)
	log.SetOutput(lg)

	cfg, err := readConfig(os.Stdin)
	_ = os.Stdin.Close()
	if err != nil {
		lg.Raw("AirBridge: " + err.Error())
		return 2
	}
	red.Add(cfg.AuthKey)
	red.Add(cfg.ControlToken)
	red.Add(cfg.InboxToken)

	// No log upload, no "logs and support" channel to Tailscale Inc.: TS_NO_LOGS_NO_SUPPORT
	// makes logpolicy's transport a no-op and logtail.Disable() stops uploads AND local
	// buffering for the whole process (tailscale.com@v1.104.7 logtail.go:736, logpolicy.go:895).
	if cleared := scrubTailscaleEnv(strings.HasPrefix(cfg.ControlURL, "http://")); len(cleared) > 0 {
		lg.Logf("ignoring %d TS_*/TSNET_* environment variable(s)", len(cleared))
	}
	envknob.SetNoLogsNoSupport()
	logtail.Disable()

	if err := ensurePrivateDir(cfg.StateDir); err != nil {
		lg.Raw("AirBridge: " + err.Error())
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if cfg.ParentPID > 0 {
		go watchParent(ctx, cfg.ParentPID, stop)
	}

	inbox := &inboxTarget{}
	if cfg.InboxURL != "" {
		p, _ := inboxPortFromURL(cfg.InboxURL)
		inbox.set(p, cfg.InboxToken)
	}

	var (
		mu       sync.Mutex
		be       netBackend = loginOnlyBackend{}
		startErr string
	)
	getBE := func() netBackend { mu.Lock(); defer mu.Unlock(); return be }
	getErr := func() string { mu.Lock(); defer mu.Unlock(); return startErr }

	controlURL, _ := validateControlURL(cfg.ControlURL)
	srv := &tsnet.Server{
		Dir:        cfg.StateDir,
		Hostname:   cfg.Hostname,
		ControlURL: controlURL,
		Ephemeral:  false,
		AuthKey:    cfg.AuthKey,
		UserLogf:   lg.Logf,
	}
	if cfg.Verbose {
		srv.Logf = lg.Logf
	}
	hasState := fileExists(filepath.Join(cfg.StateDir, "tailscaled.state"))
	tsStarted := false

	post := func(ctx context.Context, peerIP string, body []byte, hdr http.Header) (int, []byte, error) {
		return postToPeer(ctx, srv.HTTPClient(), peerIP, body, hdr)
	}

	api := &controlAPI{
		bearer:   []byte("Bearer " + cfg.ControlToken),
		be:       getBE,
		post:     post,
		inbox:    inbox,
		startErr: getErr,
		logf:     lg.Logf,
	}
	ln, host, err := listenControl()
	if err != nil {
		lg.Raw("AirBridge: cannot bind the local control API: " + err.Error())
		return 1
	}
	api.setHost(expectedHostFor(ln.Addr()))
	// S-4: bounded timeouts so a local client cannot pin connections. WriteTimeout covers /send
	// (sendTimeout 10 s to the peer) and /logout (20 s) with margin.
	ctlSrv := &http.Server{
		Handler:           api,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      40 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	go func() { _ = ctlSrv.Serve(ln) }()

	var meshSrv *http.Server
	if cfg.AuthKey != "" || hasState {
		tsStarted = true
		if err := srv.Start(); err != nil {
			mu.Lock()
			startErr = "the private network could not start"
			mu.Unlock()
			lg.Logf("tsnet start failed: %v", err)
		} else if lc, err := srv.LocalClient(); err != nil {
			mu.Lock()
			startErr = "the private network could not start"
			mu.Unlock()
			lg.Logf("tsnet local client failed: %v", err)
		} else {
			mu.Lock()
			be = localBackend{lc: lc}
			mu.Unlock()
			// The ONLY listener on the private network.
			meshLn, err := srv.Listen("tcp", ":"+strconv.Itoa(meshPort))
			if err != nil {
				mu.Lock()
				startErr = "the private network could not start"
				mu.Unlock()
				lg.Logf("mesh listen failed: %v", err)
			} else {
				meshSrv = &http.Server{
					Handler:           newMeshHandler(getBE(), inbox, lg.Logf),
					ReadHeaderTimeout: 10 * time.Second,
					ReadTimeout:       30 * time.Second,
					WriteTimeout:      30 * time.Second,
					MaxHeaderBytes:    16 << 10,
				}
				go func() { _ = meshSrv.Serve(meshLn) }()
			}
		}
	} else {
		lg.Logf("no saved network state and no enrollment key: waiting for sign-in")
	}
	api.onLogout = func() { lg.Logf("logged out of the private network") }

	ready, _ := json.Marshal(map[string]any{"port": ln.Addr().(*net.TCPAddr).Port, "pid": os.Getpid(), "host": host})
	lg.Raw(readyPrefix + " " + string(ready))
	lg.Logf("started (hostname %s, %s/%s)", cfg.Hostname, runtime.GOOS, runtime.GOARCH)

	<-ctx.Done()
	lg.Logf("stopping")
	shut, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = ctlSrv.Shutdown(shut)
	if meshSrv != nil {
		_ = meshSrv.Shutdown(shut)
	}
	if tsStarted {
		_ = srv.Close()
	}
	return 0
}

// listenControl binds [::1]:0, falling back to 127.0.0.1:0 on hosts without IPv6 loopback.
// (Unlike userspace tailscaled, tsnet never forwards mesh traffic to host loopback, so the
// IPv4 fallback is not reachable from the private network either.)
func listenControl() (net.Listener, string, error) {
	if ln, err := net.Listen("tcp6", "[::1]:0"); err == nil {
		return ln, "::1", nil
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, "", err
	}
	return ln, "127.0.0.1", nil
}

func postToPeer(ctx context.Context, client *http.Client, peerIP string, body []byte, hdr http.Header) (int, []byte, error) {
	c := *client
	c.Timeout = sendTimeout
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	url := "http://" + net.JoinHostPort(peerIP, strconv.Itoa(meshPort)) + "/incoming_task"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytesReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header = hdr.Clone()
	resp, err := c.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, maxReplyBody))
	return resp.StatusCode, b, nil
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

// ensurePrivateDir creates dir 0700 and refuses symlinks / other owners (F-8).
func ensurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("cannot create the network state directory")
	}
	st, err := os.Lstat(dir)
	if err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return errors.New("unsafe network state directory")
	}
	if !ownedByMe(dir, st) {
		return errors.New("network state directory is owned by another user")
	}
	if runtime.GOOS != "windows" && st.Mode().Perm()&0o077 != 0 { // Windows: per-user %APPDATA% ACLs
		if err := os.Chmod(dir, 0o700); err != nil {
			return errors.New("cannot restrict the network state directory")
		}
	}
	return nil
}

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }
