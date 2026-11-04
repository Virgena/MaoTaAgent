package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:bootstrap
var embedded embed.FS

var version = "0.0.0"

type App struct {
	ctx      context.Context
	launcher *launcher
	domReady chan struct{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if a.launcher != nil {
		a.launcher.ctx = ctx
		go a.launcher.run()
	}
}

func (a *App) ready(ctx context.Context) {
	if a.launcher != nil {
		a.launcher.markReady()
	}
}

func (a *App) shutdown(ctx context.Context) {
	if a.launcher != nil {
		a.launcher.stop()
	}
}

func openLog(cache string) (string, *os.File, error) {
	dir := filepath.Join(cache, "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", nil, err
	}
	path := filepath.Join(dir, "desktop.log")
	for index := 2; index >= 1; index-- {
		from := fmt.Sprintf("%s.%d", path, index)
		to := fmt.Sprintf("%s.%d", path, index+1)
		_ = os.Rename(from, to)
	}
	_ = os.Rename(path, path+".1")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return path, nil, err
	}
	return path, file, nil
}

func main() {
	dir := appDir()
	home := ensureDir(resolveDataDir(os.Getenv("MAOTA_HOME"), os.Getenv("APPDATA"), dir), filepath.Join(dir, ".maota"))
	cache := ensureDir(resolveCacheDir(os.Getenv("LOCALAPPDATA"), dir), filepath.Join(dir, ".cache"))

	logPath, logFile, logErr := openLog(cache)
	if logErr == nil {
		defer logFile.Close()
		log.SetOutput(logFile)
	}
	logger := log.New(log.Writer(), "", log.LstdFlags)
	logger.Println("MaoTa desktop", version)
	logger.Println("dir:", dir, "home:", home, "cache:", cache, "log:", logPath)
	logger.Println("data dir from env:", os.Getenv("MAOTA_HOME"), "appdata:", os.Getenv("APPDATA"))

	node := pickNode(os.Getenv("MAOTA_NODE"), dir, exec.LookPath)
	logger.Println("node:", node)

	assets, err := fs.Sub(embedded, "bootstrap")
	if err != nil {
		logger.Fatal(err)
	}

	app := &App{domReady: make(chan struct{})}
	app.launcher = newLauncher(context.Background(), dir, home, node, logPath, logger)

	err = wails.Run(&options.App{
		Title:     "MaoTa " + version,
		Width:     1280,
		Height:    860,
		MinWidth:  900,
		MinHeight: 600,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup:  app.startup,
		OnDomReady: app.ready,
		OnShutdown: app.shutdown,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "maota-desktop-single-instance",
			OnSecondInstanceLaunch: func(options.SecondInstanceData) {
				runtime.WindowShow(app.ctx)
				runtime.WindowUnminimise(app.ctx)
			},
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			WebviewUserDataPath:  webviewDir(cache, dir),
		},
	})
	if err != nil {
		logger.Fatal(err)
	}
}
