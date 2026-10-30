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

function askTerminal(label: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    let settled = false;
    // Without these, Ctrl+D or Ctrl+C left the question pending and the
    // process exited with status 0 as if the command had succeeded.
    const cancel = () => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(new PromptCancelledError());
    };
    rl.once('close', cancel);
    rl.once('SIGINT', cancel);
    rl.question(label, (answer) => {
      settled = true;
      rl.close();
      resolve(answer);
    });
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
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (stdin.destroyed || stdin.readableEnded) throw new PromptCancelledError();
  const wasRaw = !!stdin.isRaw;
  const wasFlowing = stdin.readableFlowing === true;

  stdout.write(`${color(question, ANSI.bold)}\n`);
  stdout.write(color(`  ${t('prompt.navigate')}\n`, ANSI.dim));

  let cursor = 0;
  renderChoiceList(choices, cursor);

  return new Promise((resolve, reject) => {
    let settled = false;
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);

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

    const cleanup = () => {
      clearNumericTimer();
      if (!stdin.destroyed) stdin.setRawMode(wasRaw);
      if (wasFlowing) stdin.resume(); else stdin.pause();
      stdin.removeListener('data', onData);
      stdin.removeListener('end', cancel);
      stdin.removeListener('close', cancel);
      stdin.removeListener('error', fail);
    };

    const select = (index: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearLines(choices.length);
      stdout.write(`${color('❯', ANSI.cyan)} ${choices[index]}\n`);
      resolve(choices[index]);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = () => fail(new PromptCancelledError());

    const commitNumeric = () => {
      const value = Number.parseInt(numericBuffer, 10);
      numericBuffer = '';
      clearNumericTimer();
      if (Number.isInteger(value) && value >= 1 && value <= choices.length) {
        select(value - 1);
      }
    };

    const move = (delta: number) => {
      clearLines(choices.length);
      cursor = (cursor + delta + choices.length) % choices.length;
      renderChoiceList(choices, cursor);
    };

    const onData = (data: string) => {
      if (data === '\u0003' || data === '\u0004' || data === '\u001b') {
        cancel();
        return;
      }
      if (data === '\r' || data === '\n') {
        if (numericBuffer) {
          commitNumeric();
          return;
        }
        select(cursor);
        return;
      }
      if (data === '\u001b[A' || data === 'k') {
        move(-1);
        return;
      }
      if (data === '\u001b[B' || data === 'j') {
        move(1);
        return;
      }
      if (/^[0-9]$/.test(data)) {
        const candidate = Number.parseInt(numericBuffer + data, 10);
        if (candidate === 0 || candidate > choices.length) {
          numericBuffer = '';
          clearNumericTimer();
          return;
        }
        numericBuffer += data;
        if (candidate * 10 > choices.length) {
          commitNumeric();
          return;
        }
        clearNumericTimer();
        numericTimer = setTimeout(commitNumeric, 700);
      }
    };

    stdin.on('data', onData);
    stdin.once('end', cancel);
    stdin.once('close', cancel);
    stdin.once('error', fail);
  });
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
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (stdin.destroyed || stdin.readableEnded) throw new PromptCancelledError();
  const wasRaw = !!stdin.isRaw;
  const wasFlowing = stdin.readableFlowing === true;

  stdout.write(`${color(question, ANSI.bold)}\n`);
  stdout.write(color(`  ${t('prompt.multiSelect')}\n`, ANSI.dim));

  let cursor = 0;
  const selected = new Set<number>();
  renderChoiceList(choices, cursor, selected);

  return new Promise((resolve, reject) => {
    let settled = false;
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);

    const cleanup = () => {
      if (!stdin.destroyed) stdin.setRawMode(wasRaw);
      if (wasFlowing) stdin.resume(); else stdin.pause();
      stdin.removeListener('data', onData);
      stdin.removeListener('end', cancel);
      stdin.removeListener('close', cancel);
      stdin.removeListener('error', fail);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = () => fail(new PromptCancelledError());

    const confirmSelection = () => {
      if (settled) return;
      settled = true;
      cleanup();
      clearLines(choices.length);
      const result = choices.filter((_, i) => selected.has(i));
      if (result.length) {
        stdout.write(`${color('✔', ANSI.green)} ${result.join(', ')}\n`);
      } else {
        stdout.write(`${color('—', ANSI.dim)} ${t('prompt.noneSelected')}\n`);
      }
      resolve(result);
    };

    const redraw = () => {
      clearLines(choices.length);
      renderChoiceList(choices, cursor, selected);
    };

    const onData = (data: string) => {
      if (data === '\u0003' || data === '\u0004' || data === '\u001b') {
        cancel();
        return;
      }
      if (data === '\r' || data === '\n') {
        confirmSelection();
        return;
      }
      if (data === '\u001b[A' || data === 'k') {
        cursor = (cursor - 1 + choices.length) % choices.length;
        redraw();
        return;
      }
      if (data === '\u001b[B' || data === 'j') {
        cursor = (cursor + 1) % choices.length;
        redraw();
        return;
      }
      if (data === ' ') {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        redraw();
        return;
      }
      if (data === 'a') {
        if (selected.size === choices.length) selected.clear();
        else choices.forEach((_, i) => selected.add(i));
        redraw();
      }
    };

    stdin.on('data', onData);
    stdin.once('end', cancel);
    stdin.once('close', cancel);
    stdin.once('error', fail);
  });
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
  const wasRaw = !!input.isRaw;
  const wasFlowing = input.readableFlowing === true;
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
      if (!input.destroyed) input.setRawMode(wasRaw);
      if (wasFlowing) input.resume(); else input.pause();
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
