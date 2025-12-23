/**
 * Tests for terminal formatting utilities
 */

import { describe, it, expect } from 'vitest';
import {
  colors,
  icons,
  colorize,
  bold,
  dim,
  formatCountLabel,
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
    expect(icons.success).toContain('✅');
    expect(icons.warning).toContain('⚠️');
    expect(icons.error).toContain('❌');
    expect(icons.info).toContain('ℹ️');
    expect(icons.trash).toContain('🗑️');
    expect(icons.sync).toContain('🔄');
    expect(icons.lightbulb).toContain('💡');
    expect(icons.checkmark).toContain('✓');
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
