import readline from 'node:readline';
import { Writable, type Readable } from 'node:stream';
import type { BotLocale } from '@monky/shared';
import { ANSI, color } from './constants';
import { CliError, cliText } from './locale';

export interface CliPromptIO {
  input: Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => void };
  output: Writable & { isTTY?: boolean; columns?: number };
}

export interface CliChoice<T extends string> {
  value: T;
  label: string;
}

export class CliPromptCancelled extends CliError {
  constructor() { super('Operação cancelada.', 'Operation cancelled.'); }
}

function terminal(io: CliPromptIO): void {
  if (io.input.destroyed || io.input.readableEnded) throw new CliPromptCancelled();
  if (!io.input.isTTY || !io.output.isTTY) {
    throw new CliError('Este menu exige um terminal interativo. Use os comandos e flags de --help para automação.',
      'This menu requires an interactive terminal. Use the commands and flags in --help for automation.');
  }
}

export function askCliChoice<T extends string>(
  locale: BotLocale, question: string, choices: readonly CliChoice<T>[], initial?: T,
  io: CliPromptIO = { input: process.stdin, output: process.stdout },
): Promise<T> {
  terminal(io);
  if (!choices.length || new Set(choices.map(choice => choice.value)).size !== choices.length) {
    throw new CliError('O menu precisa de opções únicas.', 'The menu requires unique choices.');
  }
  const { input, output } = io;
  if (!input.setRawMode) throw new CliError('Terminal sem suporte a navegação por setas.', 'This terminal does not support arrow navigation.');
  const wasRaw = !!input.isRaw, wasFlowing = input.readableFlowing === true;
  let cursor = Math.max(0, choices.findIndex(choice => choice.value === initial));
  const render = (): void => {
    for (const [index, choice] of choices.entries()) {
      output.write((index === cursor ? color(`> ${choice.label}`, ANSI.cyan) : `  ${choice.label}`) + '\n');
    }
  };
  output.write(`${color(question, ANSI.bold)}\n${cliText(locale,
    'Use as setas e Enter para escolher; Esc cancela.', 'Use arrow keys and Enter to select; Esc cancels.')}\n`);
  render();
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      input.off('keypress', onKey);
      input.off('end', cancel);
      input.off('close', cancel);
      input.off('error', fail);
      if (!input.destroyed) input.setRawMode?.(wasRaw);
      if (wasFlowing) input.resume(); else input.pause();
    };
    const finish = (value?: T, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (value !== undefined) resolve(value);
    };
    const cancel = (): void => finish(undefined, new CliPromptCancelled());
    const fail = (): void => finish(undefined, new CliError('Falha na entrada do terminal.', 'Terminal input failed.'));
    const onKey = (_value: string, key: readline.Key): void => {
      if (key.name === 'escape' || (key.ctrl && ['c', 'd'].includes(key.name ?? ''))) { cancel(); return; }
      if (key.name === 'return' || key.name === 'enter') { finish(choices[cursor].value); return; }
      const next = key.name === 'up' || key.name === 'k' ? (cursor - 1 + choices.length) % choices.length
        : key.name === 'down' || key.name === 'j' ? (cursor + 1) % choices.length
          : key.name === 'home' ? 0 : key.name === 'end' ? choices.length - 1 : cursor;
      if (next === cursor) return;
      cursor = next;
      output.write('\u001b[1A\u001b[2K'.repeat(choices.length));
      render();
    };
    input.on('keypress', onKey);
    input.once('end', cancel);
    input.once('close', cancel);
    input.once('error', fail);
  });
}

export async function askCliText(
  locale: BotLocale, question: string, options: { defaultValue?: string; secret?: boolean } = {},
  io: CliPromptIO = { input: process.stdin, output: process.stdout },
): Promise<string> {
  terminal(io);
  const { input, output } = io;
  const wasFlowing = input.readableFlowing === true, wasRaw = !!input.isRaw;
  let muted = false;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });
  Object.defineProperty(sink, 'columns', { get: () => output.columns ?? 80 });
  const resize = (): void => { sink.emit('resize'); };
  output.on('resize', resize);
  const rl = readline.createInterface({ input, output: sink, terminal: true, historySize: 0 });
  try {
    return await new Promise<string>((resolve, reject) => {
      const cancel = (): void => reject(new CliPromptCancelled());
      rl.once('SIGINT', cancel);
      rl.once('close', cancel);
      rl.once('error', () => reject(new CliError('Falha na entrada do terminal.', 'Terminal input failed.')));
      const hint = options.defaultValue && !options.secret ? ` [${options.defaultValue}]` : '';
      rl.question(`${question}${hint}: `, answer => {
        rl.off('close', cancel);
        resolve(answer.trim() || options.defaultValue || '');
      });
      muted = !!options.secret;
    });
  } finally {
    rl.close();
    output.off('resize', resize);
    sink.end();
    if (!input.destroyed) input.setRawMode?.(wasRaw);
    if (wasFlowing) input.resume(); else input.pause();
    if (options.secret) output.write('\n');
  }
}

export async function askCliValue<T>(
  locale: BotLocale, question: string, validate: (value: string) => T | Promise<T>,
  options: { defaultValue?: string; secret?: boolean } = {},
): Promise<T> {
  while (true) {
    const answer = await askCliText(locale, question, options);
    try { return await validate(answer); } catch (error: unknown) {
      if (!(error instanceof Error) || error instanceof CliPromptCancelled) throw error;
      console.error(error instanceof CliError ? cliText(locale, error.portuguese, error.english) : error.message);
    }
  }
}
