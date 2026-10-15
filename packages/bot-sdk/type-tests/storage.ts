import { BotClient, BotRequestError, ProtocolErrorCode } from '../src';
import type {
  BotDeviceStorageStatus, BotScreenBridge, BotScreenStorageEntry, BotScreenStorageUsage, BotStorage, BotStorageObjectInfo, BotStorageUsage,
  BotStoredObject,
} from '../src';

const bot = new BotClient({ requestedCapabilities: ['miniapps', 'server_storage', 'device_storage'], publicKey: 'a'.repeat(64) });
const storage: BotStorage = bot.storage('server');

async function autosave(state: Uint8Array): Promise<boolean> {
  const saved: BotStorageObjectInfo | null = await storage.put('nes/rom/autosave', state, { autosave: true });
  return saved !== null;
}

async function load(): Promise<Uint8Array | null> {
  const object: BotStoredObject | null = await storage.get('nes/rom/slot-1');
  return object?.data ?? null;
}

async function report(): Promise<string> {
  const usage: BotStorageUsage = await storage.usage();
  try {
    await storage.put('notes/today', 'text is stored as UTF-8', { contentType: 'text/plain; charset=utf-8' });
  } catch (error) {
    if (error instanceof BotRequestError && error.code === ProtocolErrorCode.STORAGE_FULL) return 'full';
  }
  const page = await storage.list({ prefix: 'nes/', limit: 10 });
  return `${usage.level}:${page.objects.length}:${page.next ?? ''}`;
}

// @ts-expect-error Storage data is bytes or text, never arbitrary objects.
void storage.put('invalid', { state: true });

// Inside the miniapp document: storage on this computer, missing in older clients.
declare const monkyScreen: BotScreenBridge;
const local = monkyScreen.storage;
const stopStatus = local?.onStatus((status: BotDeviceStorageStatus) => { void status; });
monkyScreen.onClose(async () => {
  // Hidden and muted, but storage keeps working: save without asking.
  const saved: boolean | undefined = await local?.set('nes/rom/autosave', new Uint8Array(4), { autosave: true });
  void saved;
});

async function restore(): Promise<number> {
  if (local?.status !== 'granted') return 0;
  const state: string | ArrayBuffer | null = await local.get('nes/rom/autosave');
  const keys: BotScreenStorageEntry[] = await local.list({ prefix: 'nes/' });
  const usage: BotScreenStorageUsage | null = await local.usage();
  return (state instanceof ArrayBuffer ? state.byteLength : 0) + keys.length + (usage?.level === 'full' ? 0 : 1);
}

// @ts-expect-error Like the server storage, text or bytes only.
void local?.set('nes/rom/slot-1', { level: 3 });
// @ts-expect-error The status is read-only.
if (local) local.status = 'granted';

void autosave;
void load;
void report;
void restore;
stopStatus?.();
