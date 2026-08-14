"use strict";

const path = require("path");

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

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readPort(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function getModeLabel(mode) {
  if (MODE_LABELS[mode]) {
    return MODE_LABELS[mode];
  }
  return mode
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const config = Object.freeze({
  port: readPort(process.env.PORT, 3000),
  publicDir: path.resolve(__dirname, "../public"),
  maxRows: readPositiveInteger(process.env.MAX_ROWS, 250),
  overlayPath: process.env.TARGET_OVERLAY || path.resolve(__dirname, "../../dist/overlay.json"),
  apiPollMs: readPositiveInteger(process.env.API_POLL_MS, 120000),
  overlayPollMs: readPositiveInteger(process.env.OVERLAY_POLL_MS, 30000),
  remoteFetchTimeoutMs: readPositiveInteger(process.env.REMOTE_FETCH_TIMEOUT_MS, 10000),
  remoteFetchMaxBytes: readPositiveInteger(process.env.REMOTE_FETCH_MAX_BYTES, 5 * 1024 * 1024),
  tarkovJsonBase: process.env.TARKOV_JSON_BASE || "https://json.tarkov.dev",
});

module.exports = {
  DEFAULT_MODES,
  VIEW_CONFIG,
  config,
  getModeLabel,
  readPositiveInteger,
  readPort,
};
