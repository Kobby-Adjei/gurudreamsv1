//go:build windows

package main

import (
	"context"
	"os"
)

func ownedByMe(os.FileInfo) bool { return true }

// watchParent waits on the parent's process handle (SYNCHRONIZE) and calls stop when it exits.
func watchParent(ctx context.Context, pid int, stop func()) {
	p, err := os.FindProcess(pid)
	if err != nil {
		stop() // already gone
		return
	}
	done := make(chan struct{})
	go func() {
		_, _ = p.Wait()
		close(done)
	}()
	select {
	case <-ctx.Done():
	case <-done:
		stop()
	}
}
