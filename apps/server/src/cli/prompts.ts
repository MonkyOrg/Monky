import readline from 'readline';
import { ANSI, color } from './constants';
import { t } from './i18n/index';

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const label = defaultValue !== undefined ? `${question} (${defaultValue}): ` : `${question}: `;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(label, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || '');
    });
  });
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
  if (stdin.destroyed || stdin.readableEnded) throw new Error(t('prompt.cancelled'));
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
    const cancel = () => fail(new Error(t('prompt.cancelled')));

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

export async function askMultiChoiceArrows(question: string, choices: string[]): Promise<string[]> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  stdout.write(`${color(question, ANSI.bold)}\n`);
  stdout.write(color(`  ${t('prompt.multiSelect')}\n`, ANSI.dim));

  let cursor = 0;
  const selected = new Set<number>();
  renderChoiceList(choices, cursor, selected);

  return new Promise((resolve, reject) => {
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };

    const onData = (data: string) => {
      if (data === '\u0003') {
        cleanup();
        reject(new Error(t('prompt.cancelled')));
        return;
      }
      if (data === '\r' || data === '\n') {
        cleanup();
        clearLines(choices.length);
        const result = choices.filter((_, i) => selected.has(i));
        if (result.length) {
          stdout.write(`${color('✔', ANSI.green)} ${result.join(', ')}\n`);
        } else {
          stdout.write(`${color('—', ANSI.dim)} ${t('prompt.noneSelected')}\n`);
        }
        resolve(result);
        return;
      }
      if (data === '\u001b[A' || data === 'k') {
        clearLines(choices.length);
        cursor = (cursor - 1 + choices.length) % choices.length;
        renderChoiceList(choices, cursor, selected);
        return;
      }
      if (data === '\u001b[B' || data === 'j') {
        clearLines(choices.length);
        cursor = (cursor + 1) % choices.length;
        renderChoiceList(choices, cursor, selected);
        return;
      }
      if (data === ' ') {
        clearLines(choices.length);
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
        renderChoiceList(choices, cursor, selected);
        return;
      }
      if (data === 'a') {
        clearLines(choices.length);
        if (selected.size === choices.length) {
          selected.clear();
        } else {
          choices.forEach((_, i) => selected.add(i));
        }
        renderChoiceList(choices, cursor, selected);
      }
    };

    stdin.on('data', onData);
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

export async function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const stdin = process.stdin;
    const stdout = process.stdout;

    const cleanup = () => {
      stdin.off('data', onData);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const onData = (chunk: Buffer | string) => {
      const input = chunk.toString('utf8');
      for (const char of input) {
        if (char === '\r' || char === '\n') {
          stdout.write('\n');
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          stdout.write('\n');
          cleanup();
          reject(new Error(t('prompt.cancelled')));
          return;
        }
        if (char === '\b' || char === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdout.write(question);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.on('data', onData);
  });
}
