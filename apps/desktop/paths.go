package main

import (
	"os"
	"path/filepath"
	"strings"
)

func appDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}

func resolveDataDir(maotaHome, appData, dir string) string {
	if strings.TrimSpace(maotaHome) != "" {
		return maotaHome
	}
	if strings.TrimSpace(appData) != "" {
		return filepath.Join(appData, "MaoTa")
	}
	return filepath.Join(dir, ".maota")
}

func resolveCacheDir(localAppData, dir string) string {
	if strings.TrimSpace(localAppData) != "" {
		return filepath.Join(localAppData, "MaoTa")
	}
	return filepath.Join(dir, ".cache")
}

func pickNode(explicit, dir string, lookPath func(string) (string, error)) string {
	if explicit != "" {
		return explicit
	}
	local := filepath.Join(dir, "node.exe")
	if info, err := os.Stat(local); err == nil && !info.IsDir() {
		return local
	}
	for _, name := range []string{"node.exe", "node"} {
		if found, err := lookPath(name); err == nil {
			return found
		}
	}
	return ""
}

func webviewDir(cache, dir string) string {
	return ensureDir(filepath.Join(cache, "webview"), filepath.Join(dir, ".webview"))
}

/// A directory we can actually write to. Preferred first, fallback second, and
/// the check is a real write: some Windows accounts can create a directory but
/// not a file inside it.
func ensureDir(preferred, fallback string) string {
	for _, dir := range []string{preferred, fallback} {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		if os.MkdirAll(dir, 0o755) != nil {
			continue
		}
		probe := filepath.Join(dir, ".write-probe")
		file, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			continue
		}
		_ = file.Close()
		_ = os.Remove(probe)
		return dir
	}
	return fallback
}

func tailLines(text string, keep int) string {
	if keep <= 0 {
		return ""
	}
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) > keep {
		lines = lines[len(lines)-keep:]
	}
	return strings.Join(lines, "\n")
}
