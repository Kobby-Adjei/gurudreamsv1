//go:build windows

package main

import (
	"context"
	"os"

	"golang.org/x/sys/windows"
)

// ownedByMe (S-3, best effort): the state directory's owner SID must be the current user, or the
// local Administrators group (the default owner of objects created from an elevated process).
// A directory planted by another (non-admin) user is refused. Errors reading the security info
// fail closed. The DACL itself is inherited from the per-user %APPDATA% and is not re-checked.
func ownedByMe(dir string, _ os.FileInfo) bool {
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return false
	}
	tok := windows.GetCurrentProcessToken()
	me, err := tok.GetTokenUser()
	if err != nil {
		return false
	}
	if owner.Equals(me.User.Sid) {
		return true
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	return err == nil && owner.Equals(admins)
}

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
