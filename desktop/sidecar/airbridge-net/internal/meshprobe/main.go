// Command meshprobe is a TEST-ONLY tool for airbridge/tests/integration/test_real_sidecar.py
// (never shipped: build-net.sh builds only the module root). It joins the private network as an
// ephemeral node with a pre-auth key and POSTs straight to <target_ip>:8989/incoming_task,
// bypassing airbridge-net's hostname-only /send, to prove the ACL and the receiver's WhoIs
// checks hold even against a node that does not use the AirBridge client.
//
//	stdin:  {"control_url","auth_key","dir","target_ip","body"}
//	stdout: {"status":N,"body":"..."} or {"error":"..."}
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"tailscale.com/envknob"
	"tailscale.com/logtail"
	"tailscale.com/tsnet"
)

func main() {
	var in struct {
		ControlURL string `json:"control_url"`
		AuthKey    string `json:"auth_key"`
		Dir        string `json:"dir"`
		TargetIP   string `json:"target_ip"`
		Body       string `json:"body"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		out(map[string]any{"error": "bad input"})
		return
	}
	envknob.SetNoLogsNoSupport()
	logtail.Disable()
	srv := &tsnet.Server{Dir: in.Dir, Hostname: "meshprobe", ControlURL: in.ControlURL, AuthKey: in.AuthKey,
		Ephemeral: true, UserLogf: func(string, ...any) {}}
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if _, err := srv.Up(ctx); err != nil {
		out(map[string]any{"error": "up: " + err.Error()})
		return
	}
	c := srv.HTTPClient()
	c.Timeout = 8 * time.Second
	resp, err := c.Post(fmt.Sprintf("http://%s:8989/incoming_task", in.TargetIP), "application/json",
		bytes.NewReader([]byte(in.Body)))
	if err != nil {
		out(map[string]any{"error": "post: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 65536))
	out(map[string]any{"status": resp.StatusCode, "body": string(b)})
}

func out(v any) { _ = json.NewEncoder(os.Stdout).Encode(v) }
