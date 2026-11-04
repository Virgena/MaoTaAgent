package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	webAddr      = "127.0.0.1:8341"
	webURL       = "http://127.0.0.1:8341/"
	readyTimeout = 90 * time.Second
	pollInterval = 400 * time.Millisecond
	killTimeout  = 3 * time.Second
	ringKeep     = 20
)

type launcher struct {
	ctx     context.Context
	dir     string
	home    string
	node    string
	logger  *log.Logger
	logPath string

	mu       sync.Mutex
	cmd      *exec.Cmd
	ring     []string
	exited   chan error
	pending  []string
	domReady bool
	stopped  bool
}

func newLauncher(ctx context.Context, dir, home, node, logPath string, logger *log.Logger) *launcher {
	return &launcher{
		ctx:     ctx,
		dir:     dir,
		home:    home,
		node:    node,
		logger:  logger,
		logPath: logPath,
		exited:  make(chan error, 1),
	}
}

func (l *launcher) remember(line string) {
	l.mu.Lock()
	l.ring = append(l.ring, line)
	if len(l.ring) > ringKeep {
		l.ring = l.ring[len(l.ring)-ringKeep:]
	}
	l.mu.Unlock()
	l.logger.Println(line)
}

func (l *launcher) tail() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.ring, "\n")
}

func js(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "null"
	}
	return string(encoded)
}

func (l *launcher) status(text string) {
	l.exec("window.maotaStatus(" + js(text) + ")")
}

func (l *launcher) fail(title, detail string) {
	l.logger.Println("failed:", title, detail)
	l.exec("window.maotaFail(" + js(title) + "," + js(detail) + "," + js(l.logPath) + ")")
}

/// Scripts run against the window, which may not have loaded its page yet: a
/// status set in the first milliseconds would otherwise vanish.
func (l *launcher) exec(script string) {
	l.mu.Lock()
	if !l.domReady {
		l.pending = append(l.pending, script)
		l.mu.Unlock()
		return
	}
	l.mu.Unlock()
	runtime.WindowExecJS(l.ctx, script)
}

func (l *launcher) markReady() {
	l.mu.Lock()
	l.domReady = true
	pending := l.pending
	l.pending = nil
	l.mu.Unlock()
	for _, script := range pending {
		runtime.WindowExecJS(l.ctx, script)
	}
}

func (l *launcher) run() {
	for attempt := 0; attempt < 2; attempt++ {
		l.exited = make(chan error, 1)
		if !l.frame(attempt) {
			return
		}
		l.logger.Println("profile looks stale; rebuilding it and retrying")
		l.resetProfile()
	}
}

/// One boot attempt. `true` means the profile was stale and a retry is due.
func (l *launcher) frame(attempt int) bool {
	l.status("正在检查运行环境…")

	if l.portOpen() {
		if l.speaksMaoTa() {
			l.navigate()
			return false
		}
		l.fail(
			"端口 8341 已被占用",
			"别的程序占着 MaoTa 要用的端口。关掉那个程序，再重新打开 MaoTa。",
		)
		return false
	}

	entry := filepath.Join(l.dir, "apps", "cli", "lib", "index.js")
	if _, err := os.Stat(entry); err != nil {
		l.fail("缺少程序文件", "没有找到 apps\\cli\\lib\\index.js。请先解压整个文件夹，再双击 maota.exe。")
		return false
	}
	if l.node == "" {
		l.fail("缺少 node.exe", "本程序需要和 node.exe 放在同一个文件夹里。请先解压整个文件夹，再双击 maota.exe。")
		return false
	}

	if err := os.MkdirAll(l.home, 0o755); err != nil {
		l.fail("无法创建数据目录", "没有写入权限："+l.home)
		return false
	}

	cmd := exec.Command(l.node, entry, "serve")
	cmd.Dir = l.dir
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	cmd.Env = append(os.Environ(),
		"NODE_ENV=production",
		"MAOTA_HOME="+l.home,
		"PATH="+filepath.Dir(l.node)+string(os.PathListSeparator)+os.Getenv("PATH"),
	)

	stdout, stdoutErr := cmd.StdoutPipe()
	stderr, stderrErr := cmd.StderrPipe()
	if stdoutErr == nil && stderrErr == nil {
		go l.drain(stdout)
		go l.drain(stderr)
	}

	l.status("正在启动插件宿主…")
	if err := cmd.Start(); err != nil {
		l.fail("启动失败", err.Error())
		return false
	}

	l.mu.Lock()
	l.cmd = cmd
	l.mu.Unlock()

	go func() {
		waitErr := cmd.Wait()
		l.remember(fmt.Sprintf("host 退出：%v", waitErr))
		select {
		case l.exited <- waitErr:
		default:
		}
	}()

	deadline := time.Now().Add(readyTimeout)
	for time.Now().Before(deadline) {
		if l.portOpen() {
			l.status("已就绪，正在打开界面…")
			l.navigate()
			return false
		}
		select {
		case waitErr := <-l.exited:
			if attempt == 0 && strings.Contains(l.tail(), "already exists and is not the link") {
				return true
			}
			l.fail(
				"插件宿主没有起来",
				fmt.Sprintf("host 提前退出（%v）。最后几行日志：\n%s", waitErr, l.tail()),
			)
			return false
		case <-time.After(pollInterval):
		}
	}
	l.fail(
		"启动超时",
		fmt.Sprintf("等了 %d 秒，界面还没就绪。最后几行日志：\n%s", int(readyTimeout/time.Second), l.tail()),
	)
	return false
}

/// Half-built profiles are what a killed first boot leaves behind: the links are
/// regenerated on the next boot, so dropping them is always safe.
func (l *launcher) resetProfile() {
	profiles := filepath.Join(l.home, "profiles")
	entries, err := os.ReadDir(profiles)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		_ = os.RemoveAll(filepath.Join(profiles, entry.Name(), "node_modules"))
	}
}

func (l *launcher) drain(reader io.Reader) {
	buffered := make([]byte, 4096)
	var pending strings.Builder
	for {
		read, err := reader.Read(buffered)
		if read > 0 {
			pending.WriteString(string(buffered[:read]))
			text := pending.String()
			for {
				at := strings.IndexByte(text, '\n')
				if at < 0 {
					break
				}
				line := strings.TrimRight(text[:at], "\r")
				if strings.TrimSpace(line) != "" {
					l.remember(line)
				}
				text = text[at+1:]
			}
			pending.Reset()
			pending.WriteString(text)
		}
		if err != nil {
			if rest := strings.TrimSpace(pending.String()); rest != "" {
				l.remember(rest)
			}
			return
		}
	}
}

func (l *launcher) navigate() {
	l.exec(fmt.Sprintf("window.maotaShow(%s)", js(webURL)))
}

func (l *launcher) portOpen() bool {
	conn, err := net.DialTimeout("tcp", webAddr, 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func (l *launcher) speaksMaoTa() bool {
	client := &http.Client{Timeout: 1200 * time.Millisecond}
	response, err := client.Get(webURL)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return false
	}
	return strings.Contains(string(body), "MaoTa") || strings.Contains(string(body), "maota")
}

func (l *launcher) stop() {
	l.mu.Lock()
	cmd := l.cmd
	l.stopped = true
	l.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	kill := exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := kill.Run(); err != nil {
		l.logger.Println("taskkill:", err)
	}
	deadline := time.Now().Add(killTimeout)
	for time.Now().Before(deadline) {
		if !l.portOpen() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	l.logger.Println("port still open after shutdown:", webAddr)
}
