// Shared view metadata for the monitor: game modes, mode labels, and the
// per-view configuration (title/lede/requiresMode/requiresLocale).
//
// This file is intentionally a dual-module: `monitor/lib/config.js` requires it
// as CommonJS on the server, and the browser loads it as a static script
// (setting `window.viewMeta`) before `app.js`. Keeping the data in one place
// avoids the server/browser copies drifting apart.
(function () {
  "use strict";

  const DEFAULT_MODES = ["regular", "pve", "pvp-season"];
  const MODE_LABELS = {
    regular: "PvP",
    pve: "PvE",
    "pvp-season": "PvP PvE Seasonal",
    "pvp-pve-seasonal": "PvP PvE Seasonal",
  };

  const VIEW_CONFIG = {
    tasks: {
      title: "Task Overrides",
      lede: "Corrections from the overlay compared to tarkov.dev.",
      requiresMode: true,
    },
    tasksAdd: {
      title: "Task Additions",
      lede: "Tasks added by the overlay that are missing from tarkov.dev.",
      requiresMode: true,
    },
    items: {
      title: "Item Overrides",
      lede: "Item corrections included in the overlay build.",
      requiresMode: false,
    },
    hideout: {
      title: "Hideout Overrides",
      lede: "Hideout corrections included in the overlay build.",
      requiresMode: false,
    },
    traders: {
      title: "Trader Overrides",
      lede: "Trader corrections included in the overlay build.",
      requiresMode: false,
    },
    editions: {
      title: "Editions",
      lede: "Game editions defined by the overlay.",
      requiresMode: false,
    },
    storyChapters: {
      title: "Story Chapters",
      lede: "Storyline chapter additions in the overlay.",
      requiresMode: false,
    },
    itemsAdd: {
      title: "Item Additions",
      lede: "Items added by the overlay.",
      requiresMode: false,
    },
    prestige: {
      title: "Prestige Overrides",
      lede: "Prestige-level corrections included in the overlay build.",
      requiresMode: false,
    },
    locales: {
      title: "Locale Corrections",
      lede: "Per-locale translation corrections in the overlay.",
      requiresMode: false,
      requiresLocale: true,
    },
    seasonalPerks: {
      title: "Seasonal Perks",
      lede: "Seasonal (pvp-season) perks defined by the overlay.",
      requiresMode: false,
    },
    craftsAdd: {
      title: "Craft Additions",
      lede: "Hideout crafts added by the overlay.",
      requiresMode: false,
    },
  };

  const meta = { DEFAULT_MODES, MODE_LABELS, VIEW_CONFIG };

  if (typeof module === "object" && module.exports) {
    module.exports = meta;
  }
  if (typeof window !== "undefined") {
    window.viewMeta = meta;
  }
})();
