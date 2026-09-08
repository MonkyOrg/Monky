import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class DevTools {
  nextId = 0;
  pending = new Map();
  errors = [];
  protocolCounts = new Map();

  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      }
      if (message.method === 'Network.webSocketFrameReceived' && message.params.response.opcode === 1) {
        try {
          const frame = JSON.parse(message.params.response.payloadData);
          if (frame && typeof frame.type === 'string') {
            this.protocolCounts.set(frame.type, (this.protocolCounts.get(frame.type) ?? 0) + 1);
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          this.errors.push(`Non-JSON WebSocket frame: ${error.message}`);
        }
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('The isolated Electron page closed before replying.'));
      }
      this.pending.clear();
    });
  }

  async call(method, params = {}) {
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools timeout: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async wait(expression, description, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await this.evaluate(expression);
      if (result) return result;
      await delay(100);
    }
    const body = await this.evaluate('document.body.innerText.slice(-6000)');
    throw new Error(`UI timeout: ${description}\n${body}`);
  }

  async click(selector) {
    await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) throw new Error('Missing or disabled: ' + ${JSON.stringify(selector)});
      element.click();
    })()`);
  }

  async input(selector, value) {
    await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled || element.readOnly) throw new Error('Input unavailable: ' + ${JSON.stringify(selector)});
      element.focus();
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }

  async key(key) {
    const codes = { Enter: 13, Tab: 9, Escape: 27, ArrowUp: 38, ArrowDown: 40 };
    await this.call('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code: key, windowsVirtualKeyCode: codes[key],
      ...(key === 'Enter' ? { text: '\r' } : {}),
    });
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key] });
  }

  async waitProtocol(type, before) {
    const deadline = Date.now() + 5000;
    while ((this.protocolCounts.get(type) ?? 0) <= before) {
      assert.ok(Date.now() < deadline, `No new ${type} reached the Electron page.`);
      await delay(25);
    }
    await this.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  }
}

export async function exerciseOfficialBotUi(ui, { screenshotDir, sendBackgroundMessage, refreshRegistry, verifySelfTarget }) {
  const field = (name) => `[data-field-name="${name}"] [data-bot-input]:not(:disabled)`;
  const screenshot = async (name) => {
    if (!screenshotDir) return;
    const { data } = await ui.call('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const select = async (command, botName = 'MonkyBot') => {
    await ui.input('#chat-message-input', `/${command}`);
    await ui.wait(`(() => {
      const menu = document.querySelector('#command-dropup');
      return menu?.offsetHeight > 0 && menu.innerText.includes(${JSON.stringify(botName)});
    })()`, `/${command} suggestions`);
    await ui.evaluate(`(() => {
      const row = [...document.querySelectorAll('#command-dropup [role="option"]')]
        .find(element => element.innerText.includes(${JSON.stringify(command)}) && element.innerText.includes(${JSON.stringify(botName)}));
      if (!row) throw new Error('The specific bot must remain selectable.');
      row.click();
    })()`);
    if (command === 'ping' || command === 'enquete') {
      await ui.wait('!document.querySelector("#chat-command-composer")?.offsetHeight', 'immediate command acknowledged');
      return;
    }
    await ui.wait('document.querySelector("#chat-command-composer")?.offsetHeight > 0', 'selected command composer');
    assert.ok(await ui.evaluate(`document.querySelector("#chat-command-composer").innerText.includes(${JSON.stringify(botName)})`));
  };
  const submitForm = async (name) => {
    await ui.evaluate(`(() => {
      const form = document.querySelector(${JSON.stringify(field(name))})?.closest('form');
      const submit = form?.querySelector('button[type="submit"]');
      if (!submit || submit.disabled) throw new Error('The active form cannot be submitted.');
      submit.click();
    })()`);
  };
  const chooseParameter = async (label) => {
    await ui.evaluate(`(() => {
      const choice = [...document.querySelectorAll('#bot-parameter-options [data-parameter-option]')]
        .find(element => element.querySelector('strong')?.textContent === ${JSON.stringify(label)});
      if (!choice) throw new Error('Missing parameter option: ' + ${JSON.stringify(label)});
      choice.click();
    })()`);
  };
  const addOptional = async (name) => {
    await ui.click('#chat-command-composer [data-bot-action="optional-parameters"]');
    await chooseParameter(name);
  };
  const normalHeight = await ui.evaluate('document.querySelector("#chat-message-input").clientHeight');

  await ui.input('#chat-message-input', '/');
  await ui.wait('document.querySelector("#command-dropup")?.offsetHeight > 0', 'grouped picker');
  assert.equal(await ui.evaluate(`(() => {
    const scroll = document.querySelector('.command-picker-scroll');
    return scroll.scrollHeight > scroll.clientHeight && scroll.getBoundingClientRect().bottom <=
      document.querySelector('#command-dropup').getBoundingClientRect().bottom;
  })()`), true, 'All commands must remain reachable inside a scrolling panel');
  await screenshot('commands-menu');
  await ui.key('Escape');
  await ui.input('#chat-message-input', '');
  await select('guided', 'Identity Bot');
  await ui.input(field('question'), 'Focused named input');
  await ui.evaluate(`document.querySelector(${JSON.stringify(field('question'))}).setSelectionRange(3, 9)`);
  const registryCount = ui.protocolCounts.get('COMMANDS_LIST_RESPONSE') ?? 0;
  await refreshRegistry();
  await ui.waitProtocol('COMMANDS_LIST_RESPONSE', registryCount);
  assert.deepEqual(await ui.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(field('question'))});
    return { focused: document.activeElement === input, value: input?.value, start: input?.selectionStart, end: input?.selectionEnd };
  })()`), { focused: true, value: 'Focused named input', start: 3, end: 9 },
  'Registry updates must preserve a selected argument and its caret');
  await screenshot('command-parameters');
  await addOptional('enabled');
  await ui.click('#chat-command-composer [data-field-name="enabled"] .toggle-switch');
  await ui.click('#chat-command-composer [data-field-name="enabled"] .toggle-switch');
  await addOptional('member');
  await ui.click('#chat-command-composer [data-bot-choice="member"]');
  assert.equal(await ui.evaluate(`(() => {
    const labels = [...document.querySelectorAll('#bot-parameter-options strong')].map(element => element.textContent);
    return labels.includes('UI Tester') && !labels.includes('MonkyBot') && !labels.includes('Identity Bot');
  })()`), true, 'Member parameters must include the caller but not bot accounts');
  await chooseParameter('UI Tester');
  await addOptional('mode');
  await ui.click('#chat-command-composer [data-bot-choice="mode"]');
  await chooseParameter('Second');
  await ui.click('#chat-command-composer button[type="submit"]');
  await ui.wait(`!!document.querySelector(${JSON.stringify(field('answer'))})`, 'typed user and choice command execution');
  verifySelfTarget();
  await ui.click('.bot-interaction-card [data-bot-action="cancel-invocation"]:not(:disabled)');
  await ui.wait(`!document.querySelector(${JSON.stringify(field('answer'))})`, 'cancelled guided command');
  assert.ok(await ui.evaluate(`document.querySelector('#chat-message-input').clientHeight >= ${normalHeight}`),
    'The normal composer must regain its usable height');
  const initialInvocations = await ui.evaluate('document.querySelectorAll(".bot-interaction-card").length');
  await select('ping');
  await ui.wait('document.querySelector("#chat-messages-feed").innerText.includes("Pong")', 'the selected bot reply');
  await ui.wait(`document.querySelectorAll('.bot-interaction-card').length === ${initialInvocations}`,
    'text-only replies replace the temporary activity card');
  assert.equal(await ui.evaluate('document.querySelector("#chat-messages-feed").innerText.includes("Identity bot ping")'), false);
  assert.equal(await ui.evaluate(`(() => {
    const context = [...document.querySelectorAll('.bot-response-context')]
      .find(element => element.innerText.includes('UI Tester') && element.innerText.includes('/ping'));
    const name = context?.closest('[data-message-id]')?.querySelector('.bot-response-bubble .chat-author-name');
    return name?.textContent === 'MonkyBot';
  })()`), true, 'Reply cards must identify the real bot and its calling user/command');
  await ui.wait(`(() => {
    const context = [...document.querySelectorAll('.bot-response-context')]
      .find(element => element.innerText.includes('UI Tester') && element.innerText.includes('/ping'));
    const image = context?.closest('[data-message-id]')?.querySelector('.bot-response-main .chat-author-avatar');
    return image?.naturalWidth > 1 && image.currentSrc.includes('/avatars/');
  })()`, 'actual official logo rendered in the response');
  const replies = await ui.evaluate('document.querySelectorAll(".bot-response-bubble").length');
  await select('ping');
  await ui.wait(`document.querySelectorAll('.bot-response-bubble').length > ${replies}`, 'second successful command use');
  await select('dado');
  await addOptional('lados');
  await ui.input(field('lados'), '1');
  const beforeInvalid = await ui.evaluate('document.querySelectorAll(".bot-interaction-card").length');
  await ui.click('#chat-command-composer button[type="submit"]');
  assert.equal(await ui.evaluate('document.querySelectorAll(".bot-interaction-card").length'), beforeInvalid,
    'Invalid parameters must not execute or count as usage');
  await ui.input(field('lados'), '20');
  await screenshot('command-selected');
  await ui.click('#chat-command-composer button[type="submit"]');
  await ui.wait('document.querySelector("#chat-messages-feed").innerText.includes("d20")', 'typed integer from the actual composer');

  await select('enquete');
  await ui.wait(`!!document.querySelector(${JSON.stringify(field('pergunta'))})`, 'private poll form');
  const question = 'UI poll question, with a comma';
  await ui.input(field('pergunta'), question);
  await ui.input(`${field('opcoes')}[data-list-index="0"]`, 'First, still one option');
  await ui.input(`${field('opcoes')}[data-list-index="1"]`, 'Second option');
  await ui.click('.bot-inline-form [data-field-name="opcoes"] [data-field-action="add"]:not(:disabled)');
  await ui.input(`${field('opcoes')}[data-list-index="2"]`, 'Third option');
  await ui.input(field('max_voters'), '1');
  await ui.input(field('pergunta'), question);
  sendBackgroundMessage();
  await ui.wait('document.querySelector("#chat-messages-feed").innerText.includes("A concurrent ordinary message")', 'concurrent chat message');
  assert.equal(await ui.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(field('pergunta'))})`), true,
    'New chat messages must preserve the active form and its focus');
  assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(field('pergunta'))}).value`), question);
  await screenshot('bot-form');
  await submitForm('pergunta');
  await ui.wait(`!document.querySelector(${JSON.stringify(field('pergunta'))})`, 'consumed poll form');
  assert.equal(await ui.evaluate(`!!document.querySelector(${JSON.stringify(field('acao'))})`), false,
    'Poll must publish without a review/confirmation step');
  await ui.wait(`(() => {
    const rows = [...document.querySelectorAll('[data-message-id]')];
    return rows.some(row => row.innerText.includes(${JSON.stringify(question)}) &&
      row.querySelector('[data-public-selector] [data-selector-value]:not(:disabled)'));
  })()`, 'public poll voting buttons');
  const selectorId = await ui.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-message-id]')]
      .find(row => row.innerText.includes(${JSON.stringify(question)}) && row.querySelector('[data-public-selector]'));
    return row.querySelector('[data-public-selector]').dataset.publicSelector;
  })()`);
  const pollSelector = `[data-public-selector="${selectorId}"]`;
  await screenshot('poll-voting');
  await ui.click(`${pollSelector} [data-selector-value]:not(:disabled)`);
  await ui.wait(`(() => {
    const poll = document.querySelector(${JSON.stringify(pollSelector)});
    return poll && [...poll.querySelectorAll('[data-selector-value]')].every(button => button.disabled) &&
      [...document.querySelectorAll('[data-message-id]')].some(row =>
        row.innerText.includes(${JSON.stringify(question)}) && /100[.,]0%/.test(row.innerText));
  })()`, 'poll closes at one voter and publishes its final result');
  assert.equal(await ui.evaluate(`Object.values(localStorage).some(value => value.includes(${JSON.stringify(question)}))`), false,
    'Frequency persistence must never include private argument values');
  await screenshot('bot-replies');

  await select('8ball');
  const beforeMissingQuestion = await ui.evaluate('document.querySelectorAll(".bot-response-bubble").length');
  await ui.click('#chat-command-composer button[type="submit"]');
  assert.equal(await ui.evaluate('document.querySelectorAll(".bot-response-bubble").length'), beforeMissingQuestion,
    '8ball must not execute without its required question');
  await ui.input(field('pergunta'), 'Will this required question work?');
  await ui.click('#chat-command-composer button[type="submit"]');
  await ui.wait('document.querySelector("#chat-messages-feed").innerText.includes("Will this required question work?")', 'required 8ball question');
  await ui.input('#chat-message-input', 'Ordinary chat still works');
  await ui.key('Enter');
  await ui.wait('document.querySelector("#chat-messages-feed").innerText.includes("Ordinary chat still works")', 'ordinary chat after commands');
  await ui.input('#chat-message-input', '/');
  await ui.wait('!!document.querySelector("[data-command-section=frequent] .command-row")', 'real usage ordering');
  assert.deepEqual(await ui.evaluate(`(() => {
    const row = document.querySelector('[data-command-section=frequent] .command-row');
    return { command: row.querySelector('.command-row-title strong').textContent, bot: row.querySelector('.command-row-bot').textContent };
  })()`), { command: '/ping', bot: 'MonkyBot' });
  await screenshot('frequent-commands');
  console.log('Electron DOM: immediate commands, required inputs, consumed forms, public poll voting/finalization, attribution, focus and ordinary chat passed.');
}

/** Uses the installed Electron/Vite, a fresh identity, and the real application. */
export async function exerciseBotUi(serverUrl, exercise) {
  const { createServer } = await import('vite');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-bot-ui-'));
  let vite;
  let electron;
  let exited;
  let devtools;
  let output = '';
  let diagnosticPort;
  try {
    vite = await createServer({
      configFile: path.join(root, 'apps', 'client', 'vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address === 'object');
    const rendererUrl = `http://127.0.0.1:${address.port}`;
    const env = {
      ...process.env,
      MONKY_HOME: path.join(dataDir, 'registry'),
      VITE_DEV_SERVER_URL: rendererUrl,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    electron = spawn(require('electron'), [
      path.join(root, 'apps', 'client'),
      `--user-data-dir=${path.join(dataDir, 'profile')}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(electron, 'exit');
    for (const stream of [electron.stdout, electron.stderr]) {
      stream.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-15000);
        diagnosticPort ??= output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];
      });
    }
    const deadline = Date.now() + 30000;
    let page;
    while (Date.now() < deadline && electron.exitCode === null) {
      if (diagnosticPort) {
        const result = await fetch(`http://127.0.0.1:${diagnosticPort}/json/list`);
        assert.equal(result.status, 200);
        const targets = await result.json();
        page = targets.find((target) => target.type === 'page' && target.url.startsWith(rendererUrl));
        if (page) break;
      }
      await delay(100);
    }
    assert.ok(page, `The isolated Electron instance did not become ready.\n${output}`);
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, 'open');
    devtools = new DevTools(socket);
    await devtools.call('Runtime.enable');
    await devtools.call('Network.enable');
    await devtools.wait('!!document.querySelector("#btn-onboard-create")', 'fresh identity onboarding');
    await devtools.click('#btn-onboard-create');
    await devtools.wait('!!document.querySelector("#onboarding-skip")', 'connection onboarding');
    await devtools.click('#onboarding-skip');
    const url = new URL(serverUrl);
    await devtools.input('#join-nickname', 'UI Tester');
    await devtools.input('#join-host', url.hostname);
    await devtools.input('#join-port', url.port);
    await devtools.click('#btn-submit-join');
    await devtools.wait('!!document.querySelector("#chat-message-input")', 'real server connection');
    await devtools.input('#chat-message-input', '/');
    await devtools.wait(`(() => {
      const menu = document.querySelector('#command-dropup');
      return menu?.offsetHeight > 0 && menu.innerText.includes('enquete') && menu.innerText.includes('MonkyBot');
    })()`, 'official command discovery in the slash menu');
    await devtools.key('Escape');
    await devtools.input('#chat-message-input', '');
    console.log('Isolated Electron UI connected to the real server with a fresh identity.');
    if (exercise) await exercise(devtools);
    assert.deepEqual(devtools.errors, [], 'Uncaught renderer errors');
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    try {
      if (devtools && devtools.socket.readyState === WebSocket.OPEN && electron?.exitCode === null) {
        await devtools.evaluate('window.api.setMinimizeToTray(false)');
        await devtools.evaluate('setTimeout(() => { void window.api.close(); }, 50); true');
        await Promise.race([exited, delay(5000)]);
      }
    } finally {
      devtools?.socket.close();
      if (electron?.exitCode === null) electron.kill();
      try {
        if (exited) await exited;
      } finally {
        try {
          if (vite) await vite.close();
        } finally {
          fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
      }
    }
  }
}
