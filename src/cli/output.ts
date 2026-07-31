/**
 * Printing, and nothing else. This module imports no core code on purpose:
 * `index.ts` pulls it in on every invocation, including `--version`, and NFR N1
 * gives the whole cold start 200 ms.
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export function write(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function writeError(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * Every command speaks both dialects: `--json` for a program, prose for a
 * person. The renderer is a thunk so the human form is never built when the
 * machine form is what was asked for.
 */
export function emit(asJson: boolean, value: unknown, render: () => string): void {
  write(asJson ? JSON.stringify(value, null, 2) : render());
}

/** Right-pads for column output without pulling in a table library. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function pluralise(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
