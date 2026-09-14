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

export async function printBotCompatibilityWarning(port: number): Promise<void> {
  const summary = (await readLocalServerPreview(port))?.botCompatibility ?? null;
  for (const warning of formatBotCompatibilityWarnings(summary)) console.log(warning);
}
