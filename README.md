# Excalidraw Low Latency Paper

An Obsidian companion plugin for Excalidraw that combines immediate-feeling ink with paper-style controls:

- Follow Excalidraw's own light/dark theme control without changing Excalidraw's UI theme
- Dark paper
- Light paper
- Native Excalidraw grid
- Ruled horizontal writing lines
- Configurable grid and ruled spacing
- Low smoothing and streamline defaults

The plugin updates only Excalidraw's paper/background settings and adds a pointer-transparent ruled-paper overlay. It never sets Excalidraw's `theme` app-state value, so it cannot change the surrounding Excalidraw UI theme. In Follow Excalidraw theme mode, the paper background follows Excalidraw's own light/dark control.

## Install

Copy `main.js`, `manifest.json`, and `data.json` into:

`.obsidian/plugins/excalidraw-low-latency-paper/`

Enable it after installing Excalidraw.

## License

MIT. See `LICENSE`.
