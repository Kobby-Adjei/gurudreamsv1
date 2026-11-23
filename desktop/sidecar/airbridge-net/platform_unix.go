//go:build !windows

package main

import (
	"context"
	"os"
	"syscall"
	"time"
)

func ownedByMe(_ string, fi os.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}

// watchParent calls stop once the parent is gone (dead, or we were reparented).
func watchParent(ctx context.Context, pid int, stop func()) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if os.Getppid() != pid || syscall.Kill(pid, 0) == syscall.ESRCH {
				stop()
				return
			}
		}
	}
}
