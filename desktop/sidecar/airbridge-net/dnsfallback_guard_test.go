package main

import (
	"os"
	"strings"
	"testing"

	"tailscale.com/net/dnsfallback"
)

// S-1 (PHASE3_SECURITY.md): tsnet's control client falls back to "bootstrap DNS" against the
// DERP servers in net/dnsfallback's compiled-in map, which upstream are Tailscale's derpN.tailscale.com.
// scripts/build-net.sh vendors tailscale.com and replaces that map with {"Regions":{}}, so the only
// DERP servers this binary knows come from our Headscale netmap. This test must run against that
// vendored tree (build-net.sh --test, or `go test -mod=vendor ./...` after build-net.sh).
func TestDNSFallbackHasNoTailscaleHosts(t *testing.T) {
	if _, err := os.Stat("vendor/tailscale.com/net/dnsfallback/dns-fallback-servers.json"); err != nil {
		t.Fatal("vendor/ missing: run desktop/scripts/build-net.sh first (it vendors tailscale.com and removes " +
			"the Tailscale-operated DNS-fallback servers), then `go test -mod=vendor ./...`")
	}
	dm := dnsfallback.GetDERPMap()
	for id, r := range dm.Regions {
		for _, n := range r.Nodes {
			if strings.HasSuffix(strings.ToLower(n.HostName), "tailscale.com") || n.IPv4 != "" || n.IPv6 != "" {
				t.Errorf("DNS fallback region %d still lists %q (%s %s)", id, n.HostName, n.IPv4, n.IPv6)
			}
		}
	}
	if len(dm.Regions) != 0 {
		t.Errorf("DNS fallback map must be empty, has %d regions", len(dm.Regions))
	}
}
