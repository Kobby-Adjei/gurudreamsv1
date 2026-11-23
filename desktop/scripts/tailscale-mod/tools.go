//go:build tools

// Package tools pins the Tailscale commands we build so `go mod tidy` keeps
// their dependencies in go.sum. Never compiled into anything.
package tools

import (
	_ "tailscale.com/cmd/tailscale"
	_ "tailscale.com/cmd/tailscaled"
)
