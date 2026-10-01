import { performance } from 'node:perf_hooks';
import type { BotCompatibilitySummary } from '@monky/shared';
import { ANSI, color } from './constants';
import { t } from './i18n/index';
import { readLocalServerPreview } from './onlineUsers';

export function formatBotCompatibilityWarnings(summary: BotCompatibilitySummary | null): string[] {
  if (!summary) {
    return [color(t('botCompatibility.unavailable'), ANSI.dim)];
  }
  const warnings: string[] = [];
  if (summary.incompatibleBots > 0) {
    warnings.push(color(t('botCompatibility.incompatible', {
      count: summary.incompatibleBots, protocol: summary.protocolVersion,
    }), ANSI.yellow));
  }
  if (summary.uncheckedBots > 0) {
    warnings.push(color(t('botCompatibility.unchecked', {
      count: summary.uncheckedBots, protocol: summary.protocolVersion,
    }), ANSI.yellow));
  }
  return warnings;
}

export async function printBotCompatibilityWarning(
  port: number,
  { waitForStartup = false }: { waitForStartup?: boolean } = {},
): Promise<void> {
  // PM2 can return "online" before the new process has opened its HTTP listener.
  const deadline = performance.now() + 10_000;
  let preview = await readLocalServerPreview(port);
  while (!preview && waitForStartup) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    const timeout = Math.min(1500, deadline - performance.now());
    if (timeout <= 0) break;
    preview = await readLocalServerPreview(port, timeout);
  }
  const summary = preview?.botCompatibility ?? null;
  for (const warning of formatBotCompatibilityWarnings(summary)) console.log(warning);
}
