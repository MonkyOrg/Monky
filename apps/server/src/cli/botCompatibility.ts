import { performance } from 'node:perf_hooks';
import type { BotCompatibilitySummary } from '@monky/shared';
import { ANSI, color } from './constants';
import { t } from './i18n/index';
import { readLocalServerPreview, type LocalServerPreview } from './onlineUsers';

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

/**
 * Polls `/preview` until the server answers or the time runs out. PM2 reports
 * "online" as soon as it spawns the process, before migrations finish and the
 * HTTP listener opens, so only an answer proves the server came up.
 */
export async function waitForLocalServerPreview(port: number, timeoutMs: number): Promise<LocalServerPreview | null> {
  const deadline = performance.now() + timeoutMs;
  let preview = await readLocalServerPreview(port, Math.max(1, Math.min(1500, timeoutMs)));
  while (!preview) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    const timeout = Math.min(1500, deadline - performance.now());
    if (timeout <= 0) break;
    preview = await readLocalServerPreview(port, timeout);
  }
  return preview;
}

export function printBotCompatibility(preview: LocalServerPreview | null): void {
  for (const warning of formatBotCompatibilityWarnings(preview?.botCompatibility ?? null)) console.log(warning);
}

export async function printBotCompatibilityWarning(
  port: number,
  { waitForStartup = false }: { waitForStartup?: boolean } = {},
): Promise<void> {
  printBotCompatibility(waitForStartup ? await waitForLocalServerPreview(port, 10_000) : await readLocalServerPreview(port));
}
