import { t } from '../i18n';
import { showAlert } from '../views/Dialog';
import { docsUrl } from './docsLinks';
import { SecureServerRequiredError } from './secureServer';

/**
 * Shows the friendly explanation, with the docs link, when the failure was a
 * missing secure connection (#874). Returns false for any other error, which
 * the caller reports as before, in the same tick.
 */
export function showSecureServerHelp(error: unknown): boolean {
  if (!(error instanceof SecureServerRequiredError)) return false;
  void showAlert({
    title: t('network.secureRequiredTitle'),
    message: error.message,
    variant: 'warning',
    link: { label: t('network.secureRequiredDocs'), url: docsUrl('reachServer') },
  });
  return true;
}
