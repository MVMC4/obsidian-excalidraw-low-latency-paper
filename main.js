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
    this.viewThemeObservers = new Map();
    this.viewChangeUnsubscribers = new Map();
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
      if (["theme", "grid", "ruled"].includes(this.settings.paperStyle)) this.applyAllViews(false);
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

  effectivePaperStyle(view, appState) {
    if (this.settings.paperStyle !== "theme") return this.settings.paperStyle;
    const theme = appState?.theme === "light" || appState?.theme === "dark"
      ? appState.theme
      : (isLightTheme() ? "light" : "dark");
    return theme;
  }

  paperState(view, currentState) {
    const mode = this.settings.paperStyle;
    const style = this.effectivePaperStyle(view, currentState);
    const excalidrawTheme = currentState?.theme === "light" || currentState?.theme === "dark"
      ? currentState.theme
      : (isLightTheme() ? "light" : "dark");
    const light = style === "light" || ((mode === "theme" || mode === "grid" || mode === "ruled") && excalidrawTheme === "light");
    const grid = mode === "grid";
    return {
      viewBackgroundColor: light ? this.settings.lightBackground : this.settings.darkBackground,
      gridModeEnabled: grid,
      gridSize: Math.max(8, Number(this.settings.gridSize) || 24),
      gridStep: Math.max(8, Number(this.settings.gridSize) || 24),
      gridColor: this.settings.gridColor,
    };
  }

  ensureViewObservers(view) {
    const api = view?.excalidrawAPI;
    if (!api) return;

    if (!this.viewChangeUnsubscribers.has(view) && typeof api.onChange === "function") {
      const unsubscribe = api.onChange(() => this.syncPaperOnly(view));
      this.viewChangeUnsubscribers.set(view, typeof unsubscribe === "function" ? unsubscribe : null);
    }

    if (!this.viewThemeObservers.has(view) && view.contentEl) {
      const root = view.contentEl.querySelector(".excalidraw") || view.contentEl;
      const observer = new MutationObserver(() => {
        if (["theme", "grid", "ruled"].includes(this.settings.paperStyle)) this.syncPaperOnly(view);
      });
      observer.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
      this.viewThemeObservers.set(view, observer);
    }
  }

  syncPaperOnly(view) {
    const api = view?.excalidrawAPI;
    if (!api || typeof api.getAppState !== "function" || typeof api.updateScene !== "function" || !this.settings.enabled) return false;
    const current = api.getAppState();
    const desired = this.paperState(view, current);
    this.updatePaperOverlay(view, current);

    const keys = ["viewBackgroundColor", "gridModeEnabled", "gridSize", "gridStep", "gridColor"];
    const changed = keys.some((key) => current?.[key] !== desired[key]);
    if (changed) api.updateScene({ appState: desired, commitToHistory: false });
    return true;
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

  updatePaperOverlay(view, appState) {
    const style = this.settings.paperStyle === "theme"
      ? "theme"
      : this.effectivePaperStyle(view, appState);
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
    this.ensureViewObservers(view);
    const currentState = api.getAppState();
    const current = currentState?.currentStrokeOptions;
    const appState = this.paperState(view, currentState);
    if (current) appState.currentStrokeOptions = this.lowLatencyOptions(current);
    api.updateScene({ appState, commitToHistory: false });
    this.updatePaperOverlay(view, currentState);
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
    for (const observer of this.viewThemeObservers.values()) observer.disconnect();
    for (const unsubscribe of this.viewChangeUnsubscribers.values()) unsubscribe?.();
    this.viewThemeObservers.clear();
    this.viewChangeUnsubscribers.clear();
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
      .setDesc("Follow theme uses Excalidraw's own light/dark control; this plugin changes only the paper background.")
      .addDropdown((dropdown) => dropdown
        .addOptions({ theme: "Follow Excalidraw theme", dark: "Dark paper", light: "Light paper", grid: "Grid paper", ruled: "Ruled paper" })
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
