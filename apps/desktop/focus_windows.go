//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	procEnumWindows              = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
)

const swRestore = 9

// / The window was created by a background process (a tool run, a scheduled
// / task), so Windows does not hand it the foreground on its own. Pick our own
// / top-level window and ask for it explicitly; the topmost toggle in reveal is
// / the fallback when the foreground lock refuses.
func focusOwnWindow() {
	pid := uint32(os.Getpid())
	var target uintptr
	callback := syscall.NewCallback(func(window, _ uintptr) uintptr {
		var owner uint32
		procGetWindowThreadProcessId.Call(window, uintptr(unsafe.Pointer(&owner)))
		if owner != pid {
			return 1
		}
		visible, _, _ := procIsWindowVisible.Call(window)
		if visible == 0 {
			return 1
		}
		target = window
		return 0
	})
	procEnumWindows.Call(callback, 0)
	if target == 0 {
		return
	}
	procShowWindow.Call(target, swRestore)
	procSetForegroundWindow.Call(target)
}
