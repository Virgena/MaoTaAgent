package main

import (
	"context"
	"errors"
	"io"
	"log"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveDataDirPrefersExplicitHome(t *testing.T) {
	if got := resolveDataDir(`D:\maota-home`, `C:\Users\me\AppData\Roaming`, `C:\app`); got != `D:\maota-home` {
		t.Fatalf("explicit home ignored: %s", got)
	}
	if got := resolveDataDir("", `C:\Users\me\AppData\Roaming`, `C:\app`); got != filepath.Join(`C:\Users\me\AppData\Roaming`, "MaoTa") {
		t.Fatalf("appdata home: %s", got)
	}
	if got := resolveDataDir("", "", `C:\app`); got != filepath.Join(`C:\app`, ".maota") {
		t.Fatalf("fallback home: %s", got)
	}
}

func TestResolveCacheDir(t *testing.T) {
	if got := resolveCacheDir(`C:\Users\me\AppData\Local`, `C:\app`); got != filepath.Join(`C:\Users\me\AppData\Local`, "MaoTa") {
		t.Fatalf("localappdata cache: %s", got)
	}
	if got := resolveCacheDir("", `C:\app`); got != filepath.Join(`C:\app`, ".cache") {
		t.Fatalf("fallback cache: %s", got)
	}
}

func TestPickNodePrefersExplicitThenLocalThenPath(t *testing.T) {
	lookup := func(name string) (string, error) { return `C:\Program Files\nodejs\` + name, nil }
	if got := pickNode(`D:\node\node.exe`, `C:\app`, lookup); got != `D:\node\node.exe` {
		t.Fatalf("explicit node ignored: %s", got)
	}
	missing := func(string) (string, error) { return "", errors.New("not found") }
	if got := pickNode("", t.TempDir(), missing); got != "" {
		t.Fatalf("expected no node, got %s", got)
	}
	if got := pickNode("", t.TempDir(), lookup); got == "" || !strings.HasSuffix(strings.ToLower(got), "node.exe") {
		t.Fatalf("path lookup: %s", got)
	}
}

func TestTailLinesKeepsTheEnd(t *testing.T) {
	text := "one\ntwo\nthree\nfour\n"
	if got := tailLines(text, 2); got != "three\nfour" {
		t.Fatalf("tail: %q", got)
	}
	if got := tailLines("", 2); got != "" {
		t.Fatalf("empty tail: %q", got)
	}
}

func testLauncher(t *testing.T) *launcher {
	t.Helper()
	return newLauncher(context.Background(), t.TempDir(), t.TempDir(), "", "", log.New(io.Discard, "", 0))
}

func TestNeedsKillOnlyWhileHostIsLive(t *testing.T) {
	if needsKill(nil, false) {
		t.Fatal("a host that was never started must not be killed")
	}
	if needsKill(exec.Command("cmd", "/c", "exit 0"), false) {
		t.Fatal("a command that never started has no process to kill")
	}
	cmd := exec.Command("cmd", "/c", "exit 0")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if !needsKill(cmd, false) {
		t.Fatal("a started process is killable while it is still ours")
	}
	if needsKill(cmd, true) {
		t.Fatal("an exited host must not be killed: the PID can belong to another process")
	}
}

func TestStopAfterHostExitDoesNotKill(t *testing.T) {
	cmd := exec.Command("cmd", "/c", "exit 0")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	l := testLauncher(t)
	l.cmd = cmd
	l.gone = true
	called := false
	l.killer = func(int) error {
		called = true
		return nil
	}
	l.stop()
	if called {
		t.Fatal("stop must not kill a PID after the host exited")
	}
}

func TestStopIsIdempotent(t *testing.T) {
	l := testLauncher(t)
	l.stopped = true
	called := false
	l.killer = func(int) error {
		called = true
		return nil
	}
	l.stop()
	if called {
		t.Fatal("a stopped launcher must not kill again")
	}
}

func TestStopKillsLiveHostOnce(t *testing.T) {
	cmd := exec.Command("cmd", "/c", "ping", "-n", "20", "127.0.0.1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	l := testLauncher(t)
	l.cmd = cmd
	calls := 0
	l.killer = func(int) error {
		calls += 1
		return nil
	}
	l.stop()
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	if calls != 1 {
		t.Fatalf("killer calls: %d", calls)
	}
}
