package main

import (
	"errors"
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
