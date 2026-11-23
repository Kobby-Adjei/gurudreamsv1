// airbridge-net: the AirBridge Pro private-network sidecar (PHASE3_PLAN.md §9).
// One process embedding tailscale.com/tsnet, pinned to an exact version (go.sum).
module airbridge.local/airbridge-net

go 1.27.4

require tailscale.com v1.104.7
