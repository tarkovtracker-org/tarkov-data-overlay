"use strict";

const path = require("path");

// Shared with the browser (loaded as a static script before app.js).
const { DEFAULT_MODES, MODE_LABELS, VIEW_CONFIG } = require("../public/view-config.js");

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_TIMER_MS = 2_147_483_647;

function readPort(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function readTimerMilliseconds(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_MS ? parsed : fallback;
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
  apiPollMs: readTimerMilliseconds(process.env.API_POLL_MS, 120000),
  overlayPollMs: readTimerMilliseconds(process.env.OVERLAY_POLL_MS, 30000),
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
  readTimerMilliseconds,
};
