/**
 * Tests for terminal formatting utilities
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  colors,
  icons,
  colorize,
  bold,
  dim,
  formatCountLabel,
  printCountSection,
} from '../src/lib/index.js';

describe('colors', () => {
  it('contains expected color codes', () => {
    expect(colors.reset).toBe('\x1b[0m');
    expect(colors.bright).toBe('\x1b[1m');
    expect(colors.red).toBe('\x1b[31m');
    expect(colors.green).toBe('\x1b[32m');
    expect(colors.yellow).toBe('\x1b[33m');
    expect(colors.blue).toBe('\x1b[34m');
    expect(colors.cyan).toBe('\x1b[36m');
    expect(colors.gray).toBe('\x1b[90m');
  });
});

describe('icons', () => {
  it('contains expected icons with colors', () => {
    expect(icons.success).toContain('OK');
    expect(icons.warning).toContain('Warning');
    expect(icons.error).toContain('Error');
    expect(icons.info).toContain('Info');
    expect(icons.trash).toContain('Deleted');
    expect(icons.sync).toContain('Fixed');
    expect(icons.lightbulb).toContain('Tip');
    expect(icons.checkmark).toContain('OK');
  });
});

describe('colorize', () => {
  it('wraps text with color codes', () => {
    const result = colorize('test', 'red');

    expect(result).toBe(`${colors.red}test${colors.reset}`);
  });

  it('works with all color keys', () => {
    for (const color of Object.keys(colors) as Array<keyof typeof colors>) {
      if (color === 'reset') continue;

      const result = colorize('test', color);
      expect(result).toContain(colors[color]);
      expect(result).toContain(colors.reset);
    }
  });
});

describe('bold', () => {
  it('wraps text with bright/bold codes', () => {
    const result = bold('test');

    expect(result).toBe(`${colors.bright}test${colors.reset}`);
  });
});

describe('dim', () => {
  it('wraps text with gray codes', () => {
    const result = dim('test');

    expect(result).toBe(`${colors.gray}test${colors.reset}`);
  });
});

describe('formatCountLabel', () => {
  it('formats label with count and color', () => {
    const result = formatCountLabel('Items', 5, 'green');

    expect(result).toContain('Items');
    expect(result).toContain('5');
    expect(result).toContain(colors.green);
    expect(result).toContain(colors.bright);
    expect(result).toContain(colors.reset);
  });

  it('handles zero count', () => {
    const result = formatCountLabel('Empty', 0, 'yellow');

    expect(result).toContain('(0)');
  });
});

describe('printCountSection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the override count in the header instead of the number of display lines', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Four display lines (entry title + nested detail), but only two entries.
    printCountSection(
      'Still needed',
      'yellow',
      ['entry-a', '   detail-a', 'entry-b', '   detail-b'],
      undefined,
      2
    );

    const header = String(logSpy.mock.calls[0][0]);
    expect(header).toContain('Still needed (2)');
  });

  it('falls back to the number of items when no count override is provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printCountSection('Items', 'green', ['a', 'b', 'c']);

    const header = String(logSpy.mock.calls[0][0]);
    expect(header).toContain('Items (3)');
  });
});
