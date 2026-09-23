import { globalInputHook } from './globalInputHook';
import { isShortcutEventChannel, type ShortcutOperation, type ShortcutWorkerMessage, type ShortcutWorkerRequest } from './shortcutWorkerProtocol';

const port = process.parentPort;

function send(message: ShortcutWorkerMessage): void {
  port.postMessage(message);
}

function apply(operation: ShortcutOperation): boolean {
  switch (operation.command) {
    case 'startCapture': return globalInputHook.startCapture();
    case 'stopCapture': return globalInputHook.stopCapture();
    default: return globalInputHook[operation.command](operation.payload);
  }
}

port.on('message', ({ data }: { data: ShortcutWorkerRequest }) => {
  if (data.type === 'shutdown') {
    globalInputHook.destroy();
    process.exit(0);
  }
  if (data.type === 'init') {
    globalInputHook.init({
      isDestroyed: () => false,
      webContents: {
        send(channel, ...args) {
          if (isShortcutEventChannel(channel)) send({ type: 'event', channel, args });
        },
      },
    });
    const configuration = data.configuration;
    if (configuration) {
      globalInputHook.setActionHotkeys(configuration.actions);
      globalInputHook.setSoundboardHotkeys(configuration.sounds);
      globalInputHook.setPttConfig(configuration.ptt);
      globalInputHook.setShortcutCapture(configuration.shortcutCapture);
      if (configuration.pttCapture) globalInputHook.startCapture();
    }
    send({ type: 'ready' });
    return;
  }
  const ok = apply(data.operation);
  send({ type: 'result', id: data.id, ok, configuration: globalInputHook.getConfiguration() });
});
