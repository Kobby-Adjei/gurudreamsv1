// Pinned build module for the bundled Tailscale client (see ../build-tailscale.sh).
// Not application code: it exists only so `go build tailscale.com/cmd/...` can
// cross-compile at an exact, checksummed version (go.sum).
module airbridge.local/tailscale-mod

go 1.24

require tailscale.com v1.104.7
