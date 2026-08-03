/**
 * Tests for the shipped mode-divergence registry
 *
 * The registry is the recorded truth the checker compares against, so its own
 * internal consistency matters: a `divergent` entry whose two modes hold the
 * same value would silently assert there is no divergence at all.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { existsSync } from 'fs';
import {
  getProjectPaths,
  loadJson5File,
  SUPPORTED_GAME_MODES,
  type TaskDivergence,
} from '../src/lib/index.js';

const { srcDir } = getProjectPaths();
const REGISTRY_PATH = join(srcDir, 'divergences', 'tasks.json5');

const registry = existsSync(REGISTRY_PATH)
  ? loadJson5File<Record<string, TaskDivergence>>(REGISTRY_PATH)
  : {};

const entries = Object.entries(registry);

describe('divergence registry', () => {
  it('exists and is non-empty', () => {
    expect(existsSync(REGISTRY_PATH)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('keys every entry by a 24-character hex task id', () => {
    for (const [taskId] of entries) {
      expect(taskId).toMatch(/^[0-9a-f]{24}$/);
    }
  });

  it('gives every entry a name, proof URL and status', () => {
    for (const [taskId, entry] of entries) {
      expect(entry.name, taskId).toBeTruthy();
      expect(entry.proof, taskId).toMatch(/^https?:\/\//);
      expect(['divergent', 'converged', 'mode-exclusive']).toContain(entry.status);
    }
  });

  it('records at least one field per entry', () => {
    for (const [taskId, entry] of entries) {
      expect(Object.keys(entry.fields).length, taskId).toBeGreaterThan(0);
    }
  });

  it('dates every field with an ISO day and a known confidence', () => {
    for (const [taskId, entry] of entries) {
      for (const [field, def] of Object.entries(entry.fields)) {
        expect(def.verified, `${taskId}.${field}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(['high', 'medium', 'low'], `${taskId}.${field}`).toContain(def.confidence);
      }
    }
  });

  it('only uses supported game modes as value keys', () => {
    const allowed = new Set<string>([
      ...SUPPORTED_GAME_MODES,
      'confidence',
      'regularSource',
      'pveSource',
      'verified',
      'note',
    ]);

    for (const [taskId, entry] of entries) {
      for (const [field, def] of Object.entries(entry.fields)) {
        for (const key of Object.keys(def)) {
          expect(allowed, `${taskId}.${field}.${key}`).toContain(key);
        }
      }
    }
  });

  describe('status consistency', () => {
    it('divergent entries record two different values', () => {
      for (const [taskId, entry] of entries) {
        if (entry.status !== 'divergent') continue;
        for (const [field, def] of Object.entries(entry.fields)) {
          expect(def.regular, `${taskId}.${field}.regular`).toBeDefined();
          expect(def.pve, `${taskId}.${field}.pve`).toBeDefined();
          expect(def.regular, `${taskId}.${field} should differ across modes`).not.toBe(
            def.pve
          );
        }
      }
    });

    it('converged entries record identical values for both modes', () => {
      for (const [taskId, entry] of entries) {
        if (entry.status !== 'converged') continue;
        for (const [field, def] of Object.entries(entry.fields)) {
          expect(def.regular, `${taskId}.${field}`).toBe(def.pve);
        }
      }
    });

    it('mode-exclusive entries record exactly one mode', () => {
      for (const [taskId, entry] of entries) {
        if (entry.status !== 'mode-exclusive') continue;
        for (const [field, def] of Object.entries(entry.fields)) {
          const present = SUPPORTED_GAME_MODES.filter((mode) => mode in def);
          expect(present, `${taskId}.${field}`).toHaveLength(1);
        }
      }
    });
  });

  it('requires a note explaining anything below high confidence', () => {
    for (const [taskId, entry] of entries) {
      for (const [field, def] of Object.entries(entry.fields)) {
        if (def.confidence === 'high') continue;
        expect(def.note, `${taskId}.${field} needs a note justifying its confidence`).toBeTruthy();
      }
    }
  });

  it('names a source for every recorded per-mode value', () => {
    for (const [taskId, entry] of entries) {
      for (const [field, def] of Object.entries(entry.fields)) {
        if (def.regular !== undefined) {
          expect(def.regularSource, `${taskId}.${field}.regularSource`).toBeTruthy();
        }
        if (def.pve !== undefined) {
          expect(def.pveSource, `${taskId}.${field}.pveSource`).toBeTruthy();
        }
      }
    }
  });
});
