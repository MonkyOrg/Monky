import { createHash } from 'crypto';
import path from 'path';

export interface DevelopmentProfile {
  userData: string;
  sessionData: string;
  cliHome: string;
  appUserModelId: string;
}

export function resolveDevelopmentProfile(options: {
  isPackaged: boolean;
  appPath: string;
  appDataPath: string;
  explicitUserData?: string;
}): DevelopmentProfile | null {
  if (options.isPackaged) return null;

  const checkoutPath = path.resolve(options.appPath);
  const checkoutKey = process.platform === 'win32' ? checkoutPath.toLowerCase() : checkoutPath;
  const id = createHash('sha256').update(checkoutKey).digest('hex').slice(0, 16);
  const userData = options.explicitUserData
    ? path.resolve(options.explicitUserData)
    : path.join(options.appDataPath, 'Monky-development', id);
  return {
    userData,
    sessionData: userData,
    cliHome: path.join(userData, 'cli'),
    appUserModelId: `com.monky.app.development.${id}`,
  };
}
