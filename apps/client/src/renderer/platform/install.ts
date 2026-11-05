import { createWebPlatformApi } from './web/webPlatform';

// The desktop preload exposes `window.api` before the page runs; the web build
// (`vite build --mode web`) installs its own bridge before any module reads it.
if (import.meta.env.MODE === 'web') window.api = createWebPlatformApi();
