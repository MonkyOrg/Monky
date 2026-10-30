import readline from 'readline';
import { Writable } from 'stream';
import { ANSI, color } from './constants';
import { t } from './i18n/index';

/** Raised when the operator cancels a prompt or its input ends (EOF, Ctrl+C, Esc). */
export class PromptCancelledError extends Error {
  constructor() {
    super(t('prompt.cancelled'));
    this.name = 'PromptCancelledError';
  }
}

/**
 * Lines of a redirected stdin, read by a single interface for the whole
 * process. A readline per question dropped the rest of the chunk it was
 * closed in, so the second answer of `printf 'a\nb\n' | monky ...` never
 * arrived and the command quietly exited with status 0.
 */
class RedirectedLines {
  private readonly lines: string[] = [];
  private readonly waiting: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private failure: Error | null = null;
  private readonly reader: readline.Interface;

  constructor(input: NodeJS.ReadableStream) {
    this.reader = readline.createInterface({ input, terminal: false, crlfDelay: Infinity });
    this.reader.on('line', (line) => {
      const waiter = this.waiting.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
      // Paused between questions so an idle stdin never keeps the process alive.
      if (this.waiting.length === 0) this.reader.pause();
    });
    this.reader.on('close', () => this.end(new PromptCancelledError()));
    input.on('error', () => this.end(new PromptCancelledError()));
    this.reader.pause();
  }

  private end(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }

  next(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.reader.resume();
    });
  }
}

const redirectedInputs = new WeakMap<NodeJS.ReadableStream, RedirectedLines>();

function readRedirectedLine(): Promise<string> {
  const input = process.stdin;
  let lines = redirectedInputs.get(input);
  if (!lines) {
    lines = new RedirectedLines(input);
    redirectedInputs.set(input, lines);
  }
  return lines.next();
}

async function askRedirected(label: string): Promise<string> {
  process.stdout.write(label);
  const answer = await readRedirectedLine();
  process.stdout.write('\n');
  return answer;
}

/**
 * Remembers the raw mode and flow a prompt found the terminal in, and returns
 * how to give it back exactly so. Every terminal prompt here ends with it, the
 * same cleanup as the bot SDK CLI's prompts (`packages/bot-sdk/src/cli/prompts.ts`).
 */
function holdTerminal(input: NodeJS.ReadStream): () => void {
  const wasRaw = !!input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  return () => {
    if (!input.destroyed) input.setRawMode(wasRaw);
    if (wasFlowing) input.resume(); else input.pause();
  };
}

type KeyOutcome<T> = { value: T } | { error: Error };

/**
 * Reads keys in raw mode until the prompt settles, then gives the terminal back
 * as it was: raw mode, flow and listeners. Esc, Ctrl+C, Ctrl+D, EOF and stream
 * errors cancel.
 *
 * Keys come from `keypress`, as in the bot SDK CLI: Node decodes the escape
 * sequences there. Raw `data` chunks were compared whole, so arrows held down
 * or digits typed quickly over SSH, which can arrive together in one read,
 * were ignored, and an arrow split across two reads cancelled the menu.
 */
function readKeys<T>(start: (settle: (outcome: KeyOutcome<T>) => void) => (key: readline.Key) => void): Promise<T> {
  const stdin = process.stdin;
  const restore = holdTerminal(stdin);
  readline.emitKeypressEvents(stdin);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: KeyOutcome<T>) => {
      if (settled) return;
      settled = true;
      stdin.off('keypress', onKeypress);
      stdin.off('end', cancel);
      stdin.off('close', cancel);
      stdin.off('error', fail);
      restore();
      if ('error' in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const fail = (error: Error) => settle({ error });
    const cancel = () => fail(new PromptCancelledError());
    const handle = start(settle);
    const onKeypress = (_text: string | undefined, key: readline.Key | undefined) => {
      if (!key) return;
      if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) cancel();
      else handle(key);
    };
    stdin.on('keypress', onKeypress);
    stdin.once('end', cancel);
    stdin.once('close', cancel);
    stdin.once('error', fail);
    try {
      stdin.setRawMode(true);
      stdin.resume();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function askTerminal(label: string): Promise<string> {
  const restore = holdTerminal(process.stdin);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      restore();
      if (answer === null) reject(new PromptCancelledError());
      else resolve(answer);
    };
    // Without these, Ctrl+D or Ctrl+C left the question pending and the
    // process exited with status 0 as if the command had succeeded.
    rl.once('close', () => finish(null));
    rl.once('SIGINT', () => finish(null));
    rl.question(label, (answer) => finish(answer));
  });
}

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const label = defaultValue !== undefined ? `${question} (${defaultValue}): ` : `${question}: `;
  const answer = process.stdin.isTTY ? await askTerminal(label) : await askRedirected(label);
  return answer.trim() || defaultValue || '';
}

export function renderChoiceList(choices: string[], cursor: number, selected?: Set<number>): void {
  const stdout = process.stdout;
  for (let i = 0; i < choices.length; i++) {
    const isCursor = i === cursor;
    const prefix = selected
      ? (selected.has(i) ? (isCursor ? '❯ ✔ ' : '  ✔ ') : (isCursor ? '❯   ' : '    '))
      : (isCursor ? '❯ ' : '  ');
    const line = `${prefix}${choices[i]}`;
    stdout.write(isCursor ? color(line, ANSI.cyan) : `${ANSI.dim}${line}${ANSI.reset}`);
    stdout.write('\n');
  }
}

export function clearLines(count: number): void {
  const stdout = process.stdout;
  for (let i = 0; i < count; i++) {
    stdout.write('\u001b[1A\u001b[2K');
  }
}

export async function askChoiceArrows(question: string, choices: string[]): Promise<string> {
  const stdout = process.stdout;
  if (process.stdin.destroyed || process.stdin.readableEnded) throw new PromptCancelledError();

  stdout.write(`${color(question, ANSI.bold)}\n`);
  stdout.write(color(`  ${t('prompt.navigate')}\n`, ANSI.dim));

  let cursor = 0;
  renderChoiceList(choices, cursor);

  // Typing "1" used to select immediately, making entries 10 and up
  // unreachable by number. Digits are buffered until no longer number can
  // match, or briefly, so multi-digit input works.
  let numericBuffer = '';
  let numericTimer: NodeJS.Timeout | null = null;
  const clearNumericTimer = () => {
    if (numericTimer) {
      clearTimeout(numericTimer);
      numericTimer = null;
    }
  };

  let index: number;
  try {
    index = await readKeys<number>((settle) => {
      const commitNumeric = () => {
        const value = Number.parseInt(numericBuffer, 10);
        numericBuffer = '';
        clearNumericTimer();
        if (Number.isInteger(value) && value >= 1 && value <= choices.length) {
          settle({ value: value - 1 });
        }
      };

      const move = (delta: number) => {
        clearLines(choices.length);
        cursor = (cursor + delta + choices.length) % choices.length;
        renderChoiceList(choices, cursor);
      };

      return (key) => {
        if (key.name === 'return' || key.name === 'enter') {
          if (numericBuffer) commitNumeric();
          else settle({ value: cursor });
          return;
        }
        if (key.name === 'up' || key.name === 'k') {
          move(-1);
          return;
        }
        if (key.name === 'down' || key.name === 'j') {
          move(1);
          return;
        }
        if (key.name && /^[0-9]$/.test(key.name)) {
          const candidate = Number.parseInt(numericBuffer + key.name, 10);
          if (candidate === 0 || candidate > choices.length) {
            numericBuffer = '';
            clearNumericTimer();
            return;
          }
          numericBuffer += key.name;
          if (candidate * 10 > choices.length) {
            commitNumeric();
            return;
          }
          clearNumericTimer();
          numericTimer = setTimeout(commitNumeric, 700);
        }
      };
    });
  } finally {
    clearNumericTimer();
  }

  clearLines(choices.length);
  stdout.write(`${color('❯', ANSI.cyan)} ${choices[index]}\n`);
  return choices[index];
}

export async function askChoiceFallback(question: string, choices: string[]): Promise<string> {
  console.log(question);
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice}`);
  });

  while (true) {
    const answer = await ask(t('prompt.selectOption'));
    const numeric = Number.parseInt(answer, 10);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
      return choices[numeric - 1];
    }
    const direct = choices.find((choice) => choice.toLowerCase() === answer.toLowerCase());
    if (direct) return direct;
    console.log(color(t('prompt.invalidOption'), ANSI.yellow));
  }
}

export async function askChoice(question: string, choices: string[]): Promise<string> {
  if (choices.length === 0) {
    throw new Error(t('prompt.noOptions'));
  }
  if (process.stdin.isTTY) {
    return askChoiceArrows(question, choices);
  }
  return askChoiceFallback(question, choices);
}

export async function confirm(question: string, defaultYes: boolean = true): Promise<boolean> {
  const suffix = ` ${t(defaultYes ? 'prompt.confirmDefaultYes' : 'prompt.confirmDefaultNo')}`;
  while (true) {
    const answer = (await ask(`${question}${suffix}`)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (['s', 'sim', 'y', 'yes'].includes(answer)) return true;
    if (['n', 'nao', 'não', 'no'].includes(answer)) return false;
    console.log(color(t('prompt.yesOrNo'), ANSI.yellow));
  }
}

/**
 * Same lifecycle as {@link askChoiceArrows}: Esc, Ctrl+C, Ctrl+D, EOF and
 * stream errors cancel, and the terminal goes back to the raw and flowing
 * state it had, instead of always leaving it cooked and paused.
 */
export async function askMultiChoiceArrows(question: string, choices: string[]): Promise<string[]> {
  const stdout = process.stdout;
  if (process.stdin.destroyed || process.stdin.readableEnded) throw new PromptCancelledError();

  stdout.write(`${color(question, ANSI.bold)}\n`);
  stdout.write(color(`  ${t('prompt.multiSelect')}\n`, ANSI.dim));

  let cursor = 0;
  const selected = new Set<number>();
  renderChoiceList(choices, cursor, selected);

  const redraw = () => {
    clearLines(choices.length);
    renderChoiceList(choices, cursor, selected);
  };

  await readKeys<void>((settle) => (key) => {
    if (key.name === 'return' || key.name === 'enter') {
      settle({ value: undefined });
      return;
    }
    if (key.name === 'up' || key.name === 'k') {
      cursor = (cursor - 1 + choices.length) % choices.length;
      redraw();
      return;
    }
    if (key.name === 'down' || key.name === 'j') {
      cursor = (cursor + 1) % choices.length;
      redraw();
      return;
    }
    if (key.name === 'space') {
      if (selected.has(cursor)) selected.delete(cursor);
      else selected.add(cursor);
      redraw();
      return;
    }
    if (key.name === 'a') {
      if (selected.size === choices.length) selected.clear();
      else choices.forEach((_, i) => selected.add(i));
      redraw();
    }
  });

  clearLines(choices.length);
  const result = choices.filter((_, i) => selected.has(i));
  if (result.length) {
    stdout.write(`${color('✔', ANSI.green)} ${result.join(', ')}\n`);
  } else {
    stdout.write(`${color('—', ANSI.dim)} ${t('prompt.noneSelected')}\n`);
  }
  return result;
}

export async function askMultiChoiceFallback(question: string, choices: string[]): Promise<string[]> {
  console.log(question);
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. [ ] ${choice}`);
  });
  console.log(color(t('prompt.enterNumbers'), ANSI.dim));

  while (true) {
    const answer = await ask(t('prompt.permissions'));
    if (!answer.trim()) {
      return [];
    }

    const result = new Set<string>();
    let valid = true;
    for (const token of answer.split(',').map((item) => item.trim()).filter(Boolean)) {
      const numeric = Number.parseInt(token, 10);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
        result.add(choices[numeric - 1]);
        continue;
      }
      const direct = choices.find((choice) => choice.toLowerCase() === token.toLowerCase());
      if (direct) {
        result.add(direct);
        continue;
      }
      valid = false;
      break;
    }

    if (valid) return [...result];
    console.log(color(t('prompt.invalidSelection'), ANSI.yellow));
  }
}

export async function askMultiChoice(question: string, choices: string[]): Promise<string[]> {
  if (process.stdin.isTTY) {
    return askMultiChoiceArrows(question, choices);
  }
  return askMultiChoiceFallback(question, choices);
}

/**
 * Reads a password without echoing it.
 *
 * Line editing comes from readline with its output muted. Collecting raw
 * keystrokes stored arrows, Home, Delete and other escape sequences inside the
 * password without the operator seeing it, so the saved password differed
 * from the one typed.
 */
export async function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return askRedirected(question);
  }

  const input = process.stdin;
  const output = process.stdout;
  const restore = holdTerminal(input);
  let muted = false;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });
  Object.defineProperty(sink, 'columns', { get: () => output.columns ?? 80 });
  const rl = readline.createInterface({ input, output: sink, terminal: true, historySize: 0 });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      sink.end();
      restore();
      output.write('\n');
      if (answer === null) reject(new PromptCancelledError());
      else resolve(answer);
    };
    rl.once('close', () => finish(null));
    rl.once('SIGINT', () => finish(null));
    rl.question(question, (answer) => finish(answer));
    muted = true;
  });
}
