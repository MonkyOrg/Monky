import type { ScreenFormat } from '@monky/shared';
import type { ChoiceCard } from '../../utils/formControls';
import { t } from '../../i18n';

/**
 * Each format a screen is shared in (#858), said in its own words: who can watch it is part of the choice.
 * The web's share dialog and the Quality settings show the same cards.
 */
export function screenFormatChoice(format: ScreenFormat): ChoiceCard<ScreenFormat> {
  return format === 'compatible'
    ? { value: 'compatible', icon: 'devices', title: t('screenShare.formatCompatible'),
      description: t('screenShare.formatCompatibleDescription') }
    : { value: 'main', icon: 'high_quality', title: t('screenShare.formatMain'),
      description: t('screenShare.formatMainDescription') };
}
