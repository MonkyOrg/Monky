'use strict';

module.exports = { runOverlayWindowSmoke, runOverlayConfigPositionSmoke };

async function runOverlayWindowSmoke() {
  const { OverlayStageView } = await import('/views/OverlayStageView.ts');
  let checks = 0, closes = 0;
  let savedCardSize;
  const layoutRequests = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const previousApi = window.api;
  const callbacks = new Map();
  const subscribe = name => callback => {
    callbacks.set(name, callback);
    return () => callbacks.delete(name);
  };
  window.api = {
    onOverlaySyncStateReceived: subscribe('state'),
    onOverlayConfigUpdated: subscribe('config'),
    onOverlayHoverChanged: subscribe('hover'),
    onOverlayResizeStateChanged: subscribe('resize'),
    closeOverlay: async () => { closes++; },
    layoutOverlayCards: async layout => {
      layoutRequests.push(structuredClone(layout));
      const key = overlay.currentState.config.minimalistMode ? 'minimalistCardSize' : 'cardSize';
      if (key === 'cardSize') savedCardSize = { ...layout.cardSize };
      callbacks.get('config')({ ...overlay.currentState.config, [key]: { ...layout.cardSize } });
      return { x: 0, y: 0, width: innerWidth, height: innerHeight };
    },
  };
  document.body.innerHTML = '<div id="app"></div>';
  const container = document.getElementById('app');
  const overlay = new OverlayStageView(container);
  const participant = {
    sessionId: 'owned-overlay-session', userId: 'owned-overlay-user', displayName: 'Overlay fixture',
    screenShareIds: [], isCameraOn: false, isMuted: false, isDeafened: false, isSpeaking: false,
  };
  const config = {
    mode: 'cameras-only', layout: 'grid', position: 'bottom-right', cardOpacity: 0.85,
    preserveAspectRatio: true, focusActiveSpeaker: false, minimalistMode: false, hideSelf: false,
  };
  const frame = () => new Promise(requestAnimationFrame);
  const root = () => container.querySelector('.overlay-stage-root');
  const border = () => getComputedStyle(root(), '::after');
  const hover = (inside, x = innerWidth / 2, y = innerHeight / 2) => callbacks.get('hover')(inside, { x, y });
  const geometry = () => JSON.stringify([...container.querySelectorAll('.overlay-stage-root, .overlay-card, .overlay-mini-item')]
    .map(element => element.getBoundingClientRect().toJSON()));
  try {
    overlay.init();
    for (const mode of ['normal', 'minimalist', 'empty']) {
      callbacks.get('state')({
        config: { ...config, minimalistMode: mode === 'minimalist', cardSize: savedCardSize },
        channelName: 'Owned overlay', participants: mode === 'empty' ? [] : [participant],
      });
      await document.fonts.ready;
      await frame();
      hover(false);
      check(border().content !== 'none' && border().opacity === '0', `${mode}: the frame must be hidden outside the overlay.`);
      const before = geometry();
      hover(true);
      check(border().opacity === '1', `${mode}: native hover reveals the frame even over draggable regions.`);
      check(['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']
        .every(property => border()[property] === '1px'), 'All four sides must be exactly one CSS pixel.');
      check(border().borderTopStyle === 'solid' && border().borderTopColor !== 'rgba(0, 0, 0, 0)',
        'The thin frame must have a visible stroke.');
      check(['top', 'right', 'bottom', 'left'].every(property => border()[property] === '8px')
        && Number.parseFloat(border().width) === innerWidth - 16 && Number.parseFloat(border().height) === innerHeight - 16,
      'The frame reserves a gutter so the complete resize indicators are centered on its edges.');
      for (const hint of root().querySelectorAll('.overlay-resize-hint')) {
        const rect = hint.getBoundingClientRect();
        const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        const direction = hint.dataset.direction;
        const corner = direction.length === 2;
        const radius = parseFloat(border().borderTopLeftRadius);
        const inset = corner ? 8 + radius - (radius - 0.5) / Math.sqrt(2) : 8;
        check((!direction.includes('n') || Math.abs(center.y - inset) < 0.2)
          && (!direction.includes('s') || Math.abs(center.y - (innerHeight - inset)) < 0.2)
          && (!direction.includes('w') || Math.abs(center.x - inset) < 0.2)
          && (!direction.includes('e') || Math.abs(center.x - (innerWidth - inset)) < 0.2),
        `${direction}: the resize indicator center must align with the frame.`);
        const path = hint.querySelector('path');
        const painted = path.getBoundingClientRect();
        check(Math.abs(painted.x + painted.width / 2 - center.x) < 0.01
          && Math.abs(painted.y + painted.height / 2 - center.y) < 0.01,
        `${direction}: the painted symbol, not just its box, is centered on the frame.`);
        if (corner) {
          const matrix = path.getCTM();
          check(Math.abs(Math.abs(matrix.b) - Math.abs(matrix.a)) < 0.001
            && (matrix.a * matrix.b > 0) === (direction === 'ne' || direction === 'sw'),
          `${direction}: the double arrow points along the native resize diagonal.`);
        }
        check(rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          'No part of a resize indicator is clipped by the native window.');
      }
      check(border().position === 'absolute' && border().pointerEvents === 'none',
        'The frame must not take up layout space or intercept pointer input.');
      check(geometry() === before, 'Hover must not resize or reposition the overlay content.');
      check(!root().querySelector('.near-pointer'), 'Hovering the center does not reveal any resize arrow.');
      const drag = root().querySelector('.overlay-cards-container, .overlay-empty-state');
      check(getComputedStyle(drag).getPropertyValue('-webkit-app-region') === 'drag',
        'Dragging the existing content region is preserved.');
      const close = root().querySelector('#btn-overlay-close');
      const bounds = close.getBoundingClientRect();
      check(close.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)),
        'The hover frame never covers the close control.');
      const previousCloses = closes;
      close.click();
      check(closes === previousCloses + 1, 'Existing overlay controls still dispatch their actions.');
      const width = innerWidth, height = innerHeight;
      for (const [direction, x, y] of [
        ['nw', 1, 1], ['n', width / 2, 1], ['ne', width - 1, 1], ['e', width - 1, height / 2],
        ['se', width - 1, height - 1], ['s', width / 2, height - 1], ['sw', 1, height - 1], ['w', 1, height / 2],
      ]) {
        hover(true, x, y);
        const hints = [...root().querySelectorAll('.near-pointer')];
        check(hints.length === 1 && hints[0].dataset.direction === direction && border().opacity === '1',
          `${mode}/${direction}: only the nearby resize indicator appears, alongside the frame.`);
      }
      callbacks.get('config')({ ...config, minimalistMode: mode === 'minimalist', cardOpacity: 0.5, cardSize: savedCardSize });
      check(border().opacity === '1', 'Re-rendering while hovered preserves the visible frame.');
      hover(false, -1, -1);
      check(border().opacity === '0' && !root().querySelector('.near-pointer'),
        'Leaving hides both the frame and every proximity indicator.');
    }
    const stableSize = { width: 148, height: 83.25 };
    callbacks.get('config')({ ...config, cardSize: stableSize });
    for (const layout of ['vertical', 'horizontal', 'grid']) {
      for (const count of [4, 3, 5]) {
        const people = Array.from({ length: count }, (_, i) => ({
          ...participant, sessionId: `owned-${i}`, userId: `owned-${i}`, displayName: `Fixture ${i}`,
        }));
        callbacks.get('state')({ config: { ...config, layout, cardSize: stableSize },
          channelName: 'Owned overlay', participants: people });
        await frame();
        const cards = [...root().querySelectorAll('.overlay-card:not(.leaving)')];
        check(cards.length === count, 'Layout changes keep all selected participants.');
        check(cards.every(card => {
          const rect = card.getBoundingClientRect();
          return Math.abs(rect.width - stableSize.width) < 0.02 && Math.abs(rect.height - stableSize.height) < 0.02;
        }), `${layout}/${count}: switching layouts and participant counts never changes individual card dimensions.`);
        check(layoutRequests.at(-1).cardSize.width === stableSize.width
          && layoutRequests.at(-1).cardSize.height === stableSize.height, 'Window layout requests retain the exact card size.');
        const request = layoutRequests.at(-1), { ratio, extraSize } = request.resizeAspect;
        const columns = layout === 'vertical' ? 1 : layout === 'horizontal' ? count : Math.ceil(Math.sqrt(count));
        const rows = Math.ceil(count / columns);
        check(Math.abs(ratio - columns * 16 / (rows * 9)) < 1e-10, 'Native aspect uses the entire grid, not one 16:9 window.');
        check(extraSize.width === 28 + (columns - 1) * 6 && extraSize.height === 58 + (rows - 1) * 6,
          'Native constraints exclude fixed padding, gaps and the toolbar from the ratio.');
        const before = geometry();
        for (const change of [{ cardOpacity: 0.6 }, { preserveAspectRatio: false }, { preserveAspectRatio: true }]) {
          callbacks.get('config')({ ...overlay.currentState.config, ...change, cardSize: stableSize });
          check(geometry() === before, 'Changing options does not change card or window geometry.');
        }
      }
    }
    callbacks.get('state')({ config: { ...config, cardSize: stableSize }, channelName: 'Owned overlay', participants: [participant] });
    await frame();
    const requestCount = layoutRequests.length;
    const retainedCard = root().querySelector('.overlay-card:not(.leaving)');
    callbacks.get('resize')(true);
    for (let i = 0; i < 20; i++) {
      hover(i % 2 === 0, i % 2 ? -1 : 1, 1);
      const toolbar = root().querySelector('.overlay-stage-topbar');
      check(root().classList.contains('is-resizing') && border().opacity === '1'
        && [...toolbar.children].every(child => getComputedStyle(child).opacity === '1'),
      'Cursor crossings during native resize cannot flicker the toolbar or border.');
      check(root().querySelector('.overlay-card:not(.leaving)') === retainedCard, 'Resizing never replaces participant cards.');
    }
    check(layoutRequests.length === requestCount, 'Live fitting sends no layout or persistence requests.');
    callbacks.get('resize')(false);
    check(layoutRequests.length === requestCount + 1, 'Releasing native resize commits one final layout.');
    check(savedCardSize.width !== stableSize.width, 'Final fitting must not restore the stale pre-gesture dimensions.');
    check(!root().classList.contains('is-resizing') && border().opacity === '0', 'Resize release restores normal hover behavior.');
    check(getComputedStyle(root().querySelector('.overlay-drag-handle')).backgroundColor === 'rgba(0, 0, 0, 0)',
      'The title has no independent background chip inside the toolbar.');
    for (const minimalistMode of [false, true]) {
      const key = minimalistMode ? 'minimalistCardSize' : 'cardSize';
      const selector = minimalistMode ? '.overlay-mini-item' : '.overlay-card:not(.leaving)';
      const people = Array.from({ length: 4 }, (_, i) => ({ ...participant, sessionId: `aspect-${i}`, userId: `aspect-${i}` }));
      callbacks.get('config')({ ...config, minimalistMode, preserveAspectRatio: false, [key]: { width: 300, height: 100 } });
      callbacks.get('state')({ config: overlay.currentState.config, channelName: 'Owned aspect', participants: people });
      const nodes = [...root().querySelectorAll(selector)];
      check(nodes.every(node => Math.abs(node.getBoundingClientRect().height - 100) < 0.02), 'Free-sized cards retain their height.');
      callbacks.get('config')({ ...overlay.currentState.config, preserveAspectRatio: true });
      const height = minimalistMode ? 45 : 168.75;
      const assertSize = () => check([...root().querySelectorAll(selector)].every(node => {
        const r = node.getBoundingClientRect();
        return Math.abs(r.width - 300) < 0.02 && Math.abs(r.height - height) < 0.02;
      }), 'Enabling aspect immediately corrects every existing card, including minimalist items.');
      assertSize();
      check(nodes.every((node, i) => root().querySelectorAll(selector)[i] === node), 'Aspect correction retains existing participant nodes.');
      for (const layout of ['horizontal', 'vertical', 'grid']) {
        callbacks.get('config')({ ...overlay.currentState.config, layout });
        assertSize();
        const request = layoutRequests.at(-1), columns = layout === 'vertical' ? 1 : layout === 'horizontal' ? 4 : 2;
        const rows = Math.ceil(4 / columns);
        check(request.width === Math.ceil(columns * 300 + (columns - 1) * 6 + 28)
          && request.height === Math.ceil(rows * height + (rows - 1) * 6 + 58),
        'Both modes request a tightly wrapped window for the selected layout.');
      }
      callbacks.get('config')({ ...overlay.currentState.config, preserveAspectRatio: false });
      assertSize();
      for (const count of [1, 4, 8]) {
        callbacks.get('config')({ ...config, minimalistMode, cardSize: undefined, minimalistCardSize: undefined });
        callbacks.get('state')({ config: overlay.currentState.config, channelName: 'Owned defaults',
          participants: Array.from({ length: count }, (_, i) => ({ ...participant, sessionId: `default-${i}`, userId: `default-${i}` })) });
        check([...root().querySelectorAll(selector)].every(node => {
          const r = node.getBoundingClientRect();
          return Math.abs(r.width - 240) < 0.02 && Math.abs(r.height - (minimalistMode ? 36 : 135)) < 0.02;
        }), 'First open/reset uses readable per-card defaults, independent of participant count.');
      }
    }
    callbacks.get('state')({ config: { ...config, layout: 'vertical', hideInactiveParticipants: true },
      channelName: 'Owned empty overlay', participants: [] });
    for (const width of [160, 268]) {
      root().style.width = `${width}px`;
      root().style.height = '400px';
      await frame();
      const empty = root().querySelector('.overlay-empty-state');
      const message = empty.lastElementChild.getBoundingClientRect(), box = empty.getBoundingClientRect();
      check(message.left - box.left >= 12 && box.right - message.right >= 12,
        'The no-video message has internal margins even in a narrow vertical overlay.');
      check(getComputedStyle(empty).textAlign === 'center' && empty.scrollWidth <= empty.clientWidth,
        'The empty-state message is centered and wraps without horizontal overflow.');
    }
    root().style.removeProperty('width');
    root().style.removeProperty('height');
    hover(true);
    window.overlayWindowHoverPreview = container.innerHTML;
    hover(false);
    window.overlayWindowIdlePreview = container.innerHTML;
  } finally {
    overlay.destroy();
    window.api = previousApi;
    document.body.classList.remove('overlay-window-mode');
    document.body.replaceChildren();
  }
  check(callbacks.size === 0, 'Destroy removes all hover/state subscriptions.');
  return checks;
}

async function runOverlayConfigPositionSmoke() {
  const [{ OverlayConfigModal }, { settingsStore }, { overlayBridgeService }, { t }, { appEvents }] = await Promise.all([
    import('/views/OverlayConfigModal.ts'), import('/stores/settingsStore.ts'), import('/core/OverlayBridgeService.ts'), import('/i18n/index.ts'), import('/core/EventBus.ts'),
  ]);
  let checks = 0, visible = true;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const original = { config: settingsStore.getOverlayConfig(), api: window.api,
    getIsOpen: overlayBridgeService.getIsOpen, syncState: overlayBridgeService.syncState, open: overlayBridgeService.open };
  const updates = [], opens = [];
  const bounds = { x: -2120, y: 150, width: 470, height: 320 };
  const cardSize = { width: 148, height: 83.25 };
  overlayBridgeService.getIsOpen = () => visible;
  overlayBridgeService.syncState = () => {};
  overlayBridgeService.open = async config => { opens.push(structuredClone(config)); return true; };
  window.api = { setOverlayConfig: async config => { updates.push(structuredClone(config)); } };
  const modal = new OverlayConfigModal();
  const find = id => document.getElementById(id);
  const preserve = expected => {
    check(settingsStore.getOverlayConfig().position === 'custom', 'Unrelated changes retain custom placement.');
    check(JSON.stringify(settingsStore.getOverlayConfig().bounds) === JSON.stringify(expected),
      'Unrelated changes retain the latest authoritative coordinates and size.');
    check(JSON.stringify(settingsStore.getOverlayConfig().cardSize) === JSON.stringify(cardSize),
      'The modal preserves individual card dimensions.');
    check(updates.every(update => !('position' in update) && !('bounds' in update)),
      'Appearance updates never resend placement or stale geometry to Main.');
  };
  try {
    settingsStore.setOverlayConfig({ ...original.config, autoOpenOnLeaveStage: false, position: 'custom', bounds, cardSize,
      minimalistCardSize: { width: 300, height: 45 } });
    settingsStore.load();
    check(JSON.stringify(settingsStore.getOverlayConfig().cardSize) === JSON.stringify(cardSize),
      'Card dimensions survive a settings reload, not just an in-memory update.');
    check(settingsStore.getOverlayConfig().minimalistCardSize?.width === 300
      && settingsStore.getOverlayConfig().minimalistCardSize?.height === 45, 'Minimalist dimensions persist independently of regular cards.');
    const savedSettings = localStorage.getItem('monky_settings');
    try {
      for (const invalid of [0, false, [], { width: -1, height: 40 }, { width: '148', height: 83.25 }]) {
        localStorage.setItem('monky_settings', JSON.stringify({ ...JSON.parse(savedSettings), overlayCardSize: invalid, overlayMinimalistCardSize: invalid }));
        settingsStore.load();
        check(settingsStore.getOverlayConfig().cardSize === undefined, 'Invalid saved card dimensions are discarded.');
        check(settingsStore.getOverlayConfig().minimalistCardSize === undefined, 'Invalid saved minimalist dimensions are discarded.');
      }
    } finally {
      localStorage.setItem('monky_settings', savedSettings);
      settingsStore.load();
    }
    modal.open();
    check(find('btn-overlay-modal-apply').textContent.includes(t('common.done')) && !find('btn-overlay-modal-cancel'),
      'Live settings offer Done, not Save/Cancel that imply pending changes.');
    visible = false;
    appEvents.emit('overlay.state_changed', false);
    check(find('btn-overlay-modal-apply').textContent.includes(t('overlay.startOverlayBtn')),
      'Closing the overlay elsewhere updates the open modal footer.');
    visible = true;
    appEvents.emit('overlay.state_changed', true);
    check(find('btn-overlay-modal-apply').textContent.includes(t('common.done')) && !find('btn-overlay-modal-cancel'),
      'Opening the overlay elsewhere restores the live-settings footer.');
    check(!document.querySelector('.overlay-pos-btn.selected'), 'A custom placement is never relabelled bottom-right.');
    check(!find('overlay-hide-stage-cb').checked && !find('overlay-hide-inactive-cb').checked,
      'Both additional visibility switches default to off.');
    for (const id of ['overlay-aspect-ratio', 'overlay-focus-speaker-cb', 'overlay-hide-self-cb', 'overlay-minimalist-cb',
      'overlay-hide-stage-cb', 'overlay-hide-inactive-cb']) {
      find(id).click();
      preserve(bounds);
      find(id).click();
    }
    for (const id of ['opt-layout-horizontal', 'opt-layout-vertical', 'opt-layout-grid', 'opt-mode-both', 'opt-mode-cameras']) {
      find(id).click();
      preserve(bounds);
    }
    find('overlay-opacity-slider').value = '55';
    find('overlay-opacity-slider').dispatchEvent(new Event('input', { bubbles: true }));
    preserve(bounds);
    find('overlay-hide-stage-cb').click();
    find('overlay-hide-inactive-cb').click();
    settingsStore.load();
    check(settingsStore.getOverlayConfig().hideStagePreviews && settingsStore.getOverlayConfig().hideInactiveParticipants,
      'The new visibility preferences are persisted.');
    find('overlay-hide-stage-cb').click();
    find('overlay-hide-inactive-cb').click();
    find('overlay-auto-open-cb').click();
    preserve(bounds);
    find('overlay-auto-open-cb').click();
    const moved = { ...bounds, x: -1900, y: 220 };
    settingsStore.setOverlayConfig({ position: 'custom', bounds: moved });
    find('overlay-aspect-ratio').click();
    preserve(moved);
    const beforeDone = updates.length;
    find('btn-overlay-modal-apply').click();
    await Promise.resolve();
    preserve(moved);
    check(updates.length === beforeDone && !find('btn-overlay-modal-apply'), 'Done only closes the modal without resaving live settings.');
    check(opens.length === 0, 'Apply on an active overlay updates in place rather than reopening it with a position preset.');

    modal.open();
    document.querySelector('[data-pos="top-left"]').click();
    check(updates.at(-1).position === 'top-left', 'Explicit corner selection still sends a positioning request.');
    updates.length = 0;
    find('overlay-hide-self-cb').click();
    check(!('position' in updates.at(-1)), 'The following toggle never repeats a prior positioning request.');
    settingsStore.setOverlayConfig({ position: 'custom', bounds: moved });
    check(!document.querySelector('.overlay-pos-btn.selected'), 'Dragging while the modal is open clears the stale preset selection.');
    modal.close();

    visible = false;
    settingsStore.setOverlayConfig({ autoOpenOnLeaveStage: true });
    modal.open();
    check(find('btn-overlay-modal-apply').textContent.includes(t('common.done')) && !find('btn-overlay-modal-cancel'),
      'Automatic mode is active even while its window is hidden.');
    const beforeAutomatic = updates.length;
    find('overlay-hide-self-cb').click();
    check(updates.length === beforeAutomatic + 1, 'Hidden automatic mode still applies changes immediately.');
    find('btn-overlay-modal-apply').click();
    await Promise.resolve();
    check(opens.length === 0 && updates.length === beforeAutomatic + 1, 'Done does not open a hidden automatic overlay or resend its settings.');
    settingsStore.setOverlayConfig({ autoOpenOnLeaveStage: false });
    modal.open();
    check(find('btn-overlay-modal-apply').textContent.includes(t('overlay.startOverlayBtn')) && !find('btn-overlay-modal-cancel'),
      'Neither inactive nor active settings offer Cancel; the header close control dismisses the modal.');
    document.querySelector('[data-pos="top-right"]').click();
    check(settingsStore.getOverlayConfig().position === 'custom', 'An inactive position choice stays a draft until Apply.');
    find('modal-close').click();
    check(!find('btn-overlay-modal-apply') && settingsStore.getOverlayConfig().position === 'custom',
      'The header close control dismisses inactive drafts without changing the previous placement.');
    modal.open();
    document.querySelector('[data-pos="top-right"]').click();
    find('btn-overlay-modal-apply').click();
    await Promise.resolve();
    check(opens.length === 1 && opens[0].position === 'top-right', 'Starting an inactive overlay applies an explicit new position.');
  } finally {
    modal.close();
    Object.assign(overlayBridgeService, { getIsOpen: original.getIsOpen, syncState: original.syncState, open: original.open });
    settingsStore.setOverlayConfig(original.config);
    window.api = original.api;
  }
  return checks;
}
