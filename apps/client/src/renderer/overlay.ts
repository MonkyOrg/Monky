import { initI18n } from './i18n';
import { initTooltips } from './core/TooltipService';
import { installImageFallback } from './utils/imageFallback';
import { OverlayStageView } from './views/OverlayStageView';

// The overlay window draws the call over games: it loads only what it renders,
// never the app, its services or their side effects (R-MEDIA-3).
installImageFallback();
initTooltips();
initI18n();
const root = document.getElementById('app');
if (root) new OverlayStageView(root).init();
