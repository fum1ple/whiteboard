package main

import (
	"embed"
	"io/fs"
	"log"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
)

//go:embed frontend/*
var frontend embed.FS

type App struct {
	shellURL string
}

func (a *App) ShellURL() string {
	return a.shellURL
}

func main() {
	shellURL := os.Getenv("WHITEBOARD_SHELL_LAB_URL")
	if len(shellURL) < len("http://127.0.0.1:") || shellURL[:len("http://127.0.0.1:")] != "http://127.0.0.1:" {
		log.Fatal("WHITEBOARD_SHELL_LAB_URL must name the local review shell")
	}
	assets, err := fs.Sub(frontend, "frontend")
	if err != nil {
		log.Fatal(err)
	}
	application := &App{shellURL: shellURL}
	if err := wails.Run(&options.App{
		Title:     "Whiteboard Review · Wails shell",
		Width:     1440,
		Height:    960,
		MinWidth:  880,
		MinHeight: 640,
		Assets:    assets,
		Bind:      []interface{}{application},
	}); err != nil {
		log.Fatal(err)
	}
}
