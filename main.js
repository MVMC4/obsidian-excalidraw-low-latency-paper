const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

const EXCALIDRAW_VIEW_TYPE = "excalidraw";
const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";
const OVERLAY_CLASS = "excalidraw-low-latency-paper-overlay";

const DEFAULT_SETTINGS = {
  enabled: true,
  paperStyle: "theme",
  gridSize: 24,
  gridColor: "#657184",
  ruledSpacing: 32,
  ruledColor: "#657184",
  darkBackground: "#111318",
  lightBackground: "#ffffff",
  smoothing: 0,
  streamline: 0,
  thinning: 0,
  linearEasing: true,
  removeTaper: true,
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isLightTheme() {
  return document.body?.classList.contains("theme-light") === true;
}

class ExcalidrawLowLatencyPaperPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() || {});
    this.overlays = new Map();
    this.addSettingTab(new PaperSettingTab(this.app, this));

    this.addCommand({
      id: "apply-paper-style",
      name: "Apply Excalidraw paper style",
      callback: () => this.applyAllViews(true),
    });
    this.addCommand({
      id: "cycle-paper-style",
      name: "Cycle Excalidraw paper style",
      callback: () => this.cyclePaperStyle(),
    });
    this.addCommand({
      id: "toggle-paper-low-latency",
      name: "Toggle Excalidraw paper low-latency mode",
      callback: () => this.toggleEnabled(),
    });
    this.addRibbonIcon("layout-dashboard", "Apply Excalidraw paper style", () => this.applyAllViews(true));

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      window.setTimeout(() => this.applyActiveView(false), 100);
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      window.setTimeout(() => this.applyAllViews(false), 100);
    }));
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => this.applyAllViews(false), 500);
    });

    this.themeObserver = new MutationObserver(() => {
      if (this.settings.paperStyle === "theme") this.applyAllViews(false);
    });
    if (document.body) this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  getExcalidrawPlugin() {
    return this.app.plugins.getPlugin(EXCALIDRAW_PLUGIN_ID);
  }

  getViews() {
    return this.app.workspace
      .getLeavesOfType(EXCALIDRAW_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view) => view && view.excalidrawAPI);
  }

  getActiveView() {
    return this.getViews().find((view) => view === this.app.workspace.activeLeaf?.view);
  }

  effectivePaperStyle() {
    return this.settings.paperStyle === "theme"
      ? (isLightTheme() ? "light" : "dark")
      : this.settings.paperStyle;
  }

  paperState() {
    const style = this.effectivePaperStyle();
    const light = style === "light" || ((style === "grid" || style === "ruled") && isLightTheme());
    const grid = style === "grid";
    return {
      viewBackgroundColor: light ? this.settings.lightBackground : this.settings.darkBackground,
      theme: light ? "light" : "dark",
      gridModeEnabled: grid,
      gridSize: Math.max(8, Number(this.settings.gridSize) || 24),
      gridStep: Math.max(8, Number(this.settings.gridSize) || 24),
      gridColor: this.settings.gridColor,
    };
  }

  lowLatencyOptions(current) {
    const options = Object.assign({}, current?.options || {});
    options.smoothing = Number(this.settings.smoothing);
    options.streamline = Number(this.settings.streamline);
    options.thinning = Number(this.settings.thinning);
    if (this.settings.linearEasing) options.easing = "linear";
    if (this.settings.removeTaper) {
      options.start = Object.assign({}, options.start || {}, { taper: 0 });
      options.end = Object.assign({}, options.end || {}, { taper: 0 });
    }
    return Object.assign({}, current || {}, { options });
  }

  ensureRuledOverlay(view) {
    const host = view?.contentEl;
    if (!host) return null;
    let overlay = this.overlays.get(view);
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement("div");
      overlay.className = OVERLAY_CLASS;
      overlay.setAttribute("aria-hidden", "true");
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "0";
      overlay.style.opacity = "0.32";
      const position = getComputedStyle(host).position;
      if (position === "static") host.style.position = "relative";
      host.insertBefore(overlay, host.firstChild);
      this.overlays.set(view, overlay);
    }
    return overlay;
  }

  updatePaperOverlay(view) {
    const style = this.effectivePaperStyle();
    const overlay = this.ensureRuledOverlay(view);
    if (!overlay) return;
    if (style === "ruled") {
      const spacing = Math.max(12, Number(this.settings.ruledSpacing) || 32);
      const color = this.settings.ruledColor || "#657184";
      overlay.style.display = "block";
      overlay.style.backgroundImage = `repeating-linear-gradient(to bottom, transparent 0, transparent ${spacing - 1}px, ${color} ${spacing - 1}px, ${color} ${spacing}px)`;
      overlay.style.backgroundSize = `100% ${spacing}px`;
    } else {
      overlay.style.display = "none";
      overlay.style.backgroundImage = "none";
    }
  }

  applyToView(view, showNotice = false) {
    const api = view?.excalidrawAPI;
    if (!api || typeof api.getAppState !== "function" || typeof api.updateScene !== "function") return false;
    if (!this.settings.enabled) return false;
    const current = api.getAppState()?.currentStrokeOptions;
    const appState = this.paperState();
    if (current) appState.currentStrokeOptions = this.lowLatencyOptions(current);
    api.updateScene({ appState, commitToHistory: false });
    this.updatePaperOverlay(view);
    return true;
  }

  applyActiveView(showNotice) {
    const applied = this.applyToView(this.getActiveView());
    if (showNotice) new Notice(applied ? "Excalidraw paper style applied." : "Open an Excalidraw drawing first.");
    return applied ? 1 : 0;
  }

  applyAllViews(showNotice) {
    const count = this.getViews().filter((view) => this.applyToView(view)).length;
    if (showNotice) new Notice(count ? `Applied paper style to ${count} Excalidraw drawing${count === 1 ? "" : "s"}.` : "Open an Excalidraw drawing first.");
    return count;
  }

  async saveAndApply() {
    await this.saveData(this.settings);
    this.applyAllViews(false);
  }

  async toggleEnabled() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveAndApply();
    new Notice(this.settings.enabled ? "Excalidraw paper low-latency mode enabled." : "Excalidraw paper low-latency mode disabled.");
  }

  async cyclePaperStyle() {
    const styles = ["theme", "dark", "light", "grid", "ruled"];
    const index = styles.indexOf(this.settings.paperStyle);
    this.settings.paperStyle = styles[(index + 1) % styles.length];
    await this.saveAndApply();
    new Notice(`Excalidraw paper: ${this.settings.paperStyle}.`);
  }

  onunload() {
    this.themeObserver?.disconnect();
    for (const overlay of this.overlays.values()) overlay.remove();
    this.overlays.clear();
  }
}

class PaperSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Excalidraw Low Latency Paper" });
    containerEl.createEl("p", { text: "Applies low-latency ink and a paper background to open Excalidraw drawings without changing drawing elements." });

    new Setting(containerEl)
      .setName("Enable mode")
      .setDesc("Apply the low-latency ink and paper profile automatically.")
      .addToggle((toggle) => toggle.setValue(Boolean(this.plugin.settings.enabled)).onChange(async (value) => {
        this.plugin.settings.enabled = value;
        await this.plugin.saveAndApply();
      }));

    new Setting(containerEl)
      .setName("Paper style")
      .setDesc("Theme follows Obsidian light/dark mode; Ruled adds horizontal writing lines.")
      .addDropdown((dropdown) => dropdown
        .addOptions({ theme: "Follow Obsidian theme", dark: "Dark", light: "Light", grid: "Grid", ruled: "Ruled" })
        .setValue(this.plugin.settings.paperStyle)
        .onChange(async (value) => {
          this.plugin.settings.paperStyle = value;
          await this.plugin.saveAndApply();
        }));

    new Setting(containerEl)
      .setName("Grid spacing")
      .addSlider((slider) => slider.setLimits(8, 80, 4).setValue(Number(this.plugin.settings.gridSize)).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.gridSize = value;
        await this.plugin.saveAndApply();
      }));

    new Setting(containerEl)
      .setName("Ruled spacing")
      .addSlider((slider) => slider.setLimits(12, 80, 4).setValue(Number(this.plugin.settings.ruledSpacing)).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.ruledSpacing = value;
        await this.plugin.saveAndApply();
      }));

    new Setting(containerEl)
      .setName("Smoothing")
      .addSlider((slider) => slider.setLimits(0, 1, 0.05).setValue(Number(this.plugin.settings.smoothing)).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.smoothing = value;
        await this.plugin.saveAndApply();
      }));

    new Setting(containerEl)
      .setName("Streamline")
      .addSlider((slider) => slider.setLimits(0, 1, 0.05).setValue(Number(this.plugin.settings.streamline)).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.streamline = value;
        await this.plugin.saveAndApply();
      }));

    new Setting(containerEl)
      .setName("Apply now")
      .addButton((button) => button.setButtonText("Apply").onClick(() => this.plugin.applyAllViews(true)));
  }
}

module.exports = ExcalidrawLowLatencyPaperPlugin;
