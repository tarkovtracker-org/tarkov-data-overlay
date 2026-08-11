/**
 * Terminal formatting utilities
 *
 * Provides consistent terminal output formatting with colors,
 * separating presentation concerns from business logic.
 */

/** ANSI color codes for terminal output */
export const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

/** Status markers with colors (plain words, shown after the label: "label : status") */
export const icons = {
  success: `${colors.green}OK${colors.reset}`,
  warning: `${colors.yellow}Warning${colors.reset}`,
  error: `${colors.red}Error${colors.reset}`,
  info: `${colors.cyan}Info${colors.reset}`,
  trash: `${colors.red}Deleted${colors.reset}`,
  sync: `${colors.yellow}Fixed${colors.reset}`,
  lightbulb: `${colors.yellow}Tip${colors.reset}`,
  checkmark: `${colors.green}OK${colors.reset}`,
} as const;

/**
 * Apply color to text
 */
export function colorize(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Make text bold/bright
 */
export function bold(text: string): string {
  return `${colors.bright}${text}${colors.reset}`;
}

/**
 * Make text dim/gray
 */
export function dim(text: string): string {
  return `${colors.gray}${text}${colors.reset}`;
}

/**
 * Print a section header with separator
 */
export function printHeader(title: string, char = '='): void {
  const line = char.repeat(80);
  console.log(line);
  console.log(bold(title));
  console.log(line);
  console.log();
}

/**
 * Print a progress message
 */
export function printProgress(message: string): void {
  console.log(`${colorize(message, 'cyan')}`);
}

/**
 * Print a success message with a trailing status marker
 */
export function printSuccess(message: string): void {
  console.log(`${message.trimEnd()} : ${icons.checkmark}`);
}

/**
 * Print an error message
 */
export function printError(message: string, error?: Error): void {
  console.error(`${colors.red}${colors.bright}${message}${colors.reset}`);
  if (error) {
    console.error(error);
  }
}

/**
 * Print a list item with optional icon
 */
export function printListItem(text: string, indent = 2): void {
  console.log(`${' '.repeat(indent)}- ${text}`);
}

/**
 * Format a count summary (e.g., "Still needed (3)"). Trailing status is
 * appended by the call site as ": <status>" when desired.
 */
export function formatCountLabel(label: string, count: number, color: keyof typeof colors): string {
  return `${colors[color]}${colors.bright}${label} (${count})${colors.reset}`;
}

/**
 * Print a "label (count) : status" header followed by one line per item, or a
 * dim "None" placeholder when the list is empty. This is the standard summary
 * section shape used by the maintenance reports.
 */
export function printCountSection(
  label: string,
  color: keyof typeof colors,
  items: string[],
  icon?: string
): void {
  console.log(`${formatCountLabel(label, items.length, color)}${icon ? ` : ${icon}` : ''}`);
  if (items.length > 0) {
    for (const item of items) {
      console.log(`  - ${item}`);
    }
  } else {
    console.log(`  ${dim('None')}`);
  }
  console.log();
}
