const glyphSelector = ':scope > .audio-state-icon, :scope > .material-symbols-outlined';

/** Observe only the footer controls, including changes made by native shortcuts. */
export function bindFooterControlsMotion(root: HTMLElement): () => void {
  return bindControlGlyphMotion(Array.from(root.querySelectorAll<HTMLButtonElement>(
    '.user-control-bar .user-quick-actions button, '
      + '.user-control-bar .user-media-bar > button:is(#media-btn-camera, #media-btn-screen, #media-btn-soundboard)',
  )));
}

export function bindChatComposerMotion(root: HTMLElement): () => void {
  return bindControlGlyphMotion(Array.from(root.querySelectorAll<HTMLButtonElement>(
    '.chat-input-container .chat-input-wrapper > button:is(#btn-attach, #btn-emoji, #btn-code)',
  )));
}

function bindControlGlyphMotion(controls: HTMLButtonElement[]): () => void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motions = new Map<HTMLButtonElement, { animations: Animation[]; decoration?: HTMLElement }>();
  const signature = (button: HTMLButtonElement) => [
    button.querySelector(glyphSelector)?.textContent?.trim(),
    button.querySelector('[data-audio-block]')?.hasAttribute('hidden'),
    button.dataset.state, button.dataset.ptt, button.dataset.pressed,
    button.getAttribute('aria-expanded'),
    button.classList.contains('danger-active'), button.classList.contains('active'),
  ].join('|');
  const states = new Map(controls.map((button) => [button, signature(button)]));

  const cancel = (button: HTMLButtonElement) => {
    const motion = motions.get(button);
    if (motion) {
      for (const animation of motion.animations) {
        animation.onfinish = null;
        animation.cancel();
      }
      motion.decoration?.remove();
      motions.delete(button);
    }
  };
  const animate = (button: HTMLButtonElement, hover = false) => {
    cancel(button);
    const glyph = button.querySelector<HTMLElement>(glyphSelector);
    if (reducedMotion.matches || button.disabled || !button.isConnected || !glyph) return;
    const motion: { animations: Animation[]; decoration?: HTMLElement } = { animations: [] };
    motions.set(button, motion);
    const play = (target: Element, frames: Keyframe[], duration: number) => {
      const animation = target.animate(frames, { duration, easing: 'ease-in-out' });
      motion.animations.push(animation);
      return animation;
    };
    const decorate = (kind: string, content: string) => {
      const layer = document.createElement('span');
      layer.className = 'control-motion-decoration';
      layer.dataset.motion = kind;
      layer.setAttribute('aria-hidden', 'true');
      layer.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round" focusable="false">${content}</svg>`;
      button.append(layer);
      motion.decoration = layer;
      return layer;
    };
    // The wrapper preserves PTT's vertical offset and keeps the prohibition badge intact.
    const animation = hover ? playHover(button, glyph, play, decorate) : play(glyph, [
      { transform: 'scale(0.88)' },
      { transform: 'scale(1)' },
    ], 140);
    animation.onfinish = () => cancel(button);
  };
  const observer = new MutationObserver(() => {
    for (const button of controls) {
      if (button.disabled || !button.isConnected) cancel(button);
      const next = signature(button);
      if (states.get(button) === next) continue;
      states.set(button, next);
      animate(button);
    }
  });
  const unbind: Array<() => void> = [];
  for (const button of controls) {
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') animate(button, true);
    };
    const click = () => {
      states.set(button, signature(button));
      animate(button);
    };
    const leave = () => cancel(button);
    button.addEventListener('pointerenter', enter);
    button.addEventListener('pointerleave', leave);
    button.addEventListener('click', click);
    observer.observe(button, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'hidden', 'disabled', 'data-state', 'data-ptt', 'data-pressed', 'aria-expanded'],
    });
    unbind.push(() => {
      button.removeEventListener('pointerenter', enter);
      button.removeEventListener('pointerleave', leave);
      button.removeEventListener('click', click);
    });
  }
  const stopMotion = () => {
    if (reducedMotion.matches) controls.forEach(cancel);
  };
  reducedMotion.addEventListener('change', stopMotion);
  return () => {
    observer.disconnect();
    reducedMotion.removeEventListener('change', stopMotion);
    unbind.forEach((off) => off());
    controls.forEach(cancel);
    states.clear();
  };
}

type Play = (target: Element, frames: Keyframe[], duration: number) => Animation;
type Decorate = (kind: string, content: string) => HTMLElement;

function playHover(button: HTMLButtonElement, glyph: HTMLElement, play: Play, decorate: Decorate): Animation {
  const transform = (values: string[], duration = 760) =>
    play(glyph, values.map((value) => ({ transform: value })), duration);
  const part = (layer: HTMLElement, selector: string, frames: Keyframe[], duration = 760) => {
    const element = layer.querySelector(selector);
    if (element) play(element, frames, duration);
  };
  const replaceGlyph = () => play(glyph, [{ opacity: 0 }, { opacity: 0 }], 760);
  switch (button.id) {
    case 'bar-btn-mic':
      return transform(['rotate(0deg)', 'translateY(-2px) rotate(-22deg)', 'rotate(16deg)',
        'translateY(-1px) rotate(-12deg)', 'rotate(0deg)']);
    case 'bar-btn-deafen':
      return transform(['scale(1)', 'translateY(-2px) scale(1.15, 0.92)', 'translateY(1px) scale(0.94, 1.08)',
        'translateY(-2px) scale(1.1, 0.96)', 'scale(1)']);
    case 'bar-btn-settings':
      return transform(['rotate(0deg)', 'rotate(180deg)', 'rotate(360deg)'], 850);
    case 'media-btn-camera': {
      // A monochrome, transient viewfinder, never a red "recording" status light.
      const layer = decorate('camera', '<path data-frame d="M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5"/>');
      part(layer, '[data-frame]', [
        { transform: 'scale(1.12)', opacity: 0 }, { transform: 'scale(0.92)', opacity: 1 },
        { transform: 'scale(1)', opacity: 0.35 }, { transform: 'scale(0.92)', opacity: 1 },
        { transform: 'scale(1.12)', opacity: 0 },
      ]);
      return transform(['scale(1)', 'scale(1.12)', 'scale(1)', 'scale(1.08)', 'scale(1)']);
    }
    case 'media-btn-screen': {
      const stopping = glyph.textContent?.trim() === 'stop_screen_share';
      const layer = decorate('screen', '<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8m-4-4v4"/>'
        + (stopping ? '<rect data-stop x="9" y="8" width="6" height="5" fill="currentColor" stroke="none"/>'
          : '<path data-arrow d="M12 14V7m-3 3 3-3 3 3"/>'));
      part(layer, stopping ? '[data-stop]' : '[data-arrow]', stopping ? [
        { opacity: 1 }, { opacity: 0.45 }, { opacity: 1 },
      ] : [
        { transform: 'translateY(2px)', opacity: 0.4 }, { transform: 'translateY(-2px)', opacity: 1 },
        { transform: 'translateY(1px)', opacity: 0.6 }, { transform: 'translateY(-2px)', opacity: 1 },
        { transform: 'translateY(0)', opacity: 1 },
      ]);
      return replaceGlyph();
    }
    case 'media-btn-soundboard': {
      const layer = decorate('music', '<path data-note-left d="M5 12V6l4-1v4M3 12a2 1.5 0 1 0 4 0 2 1.5 0 1 0-4 0"/>'
        + '<path data-note-right d="M19 17v-6l3 1M17 17a2 1.5 0 1 0 4 0 2 1.5 0 1 0-4 0"/>');
      for (const [selector, x] of [['[data-note-left]', -3], ['[data-note-right]', 3]] as const) {
        part(layer, selector, [
          { transform: 'translate(0, 3px) scale(0.6)', opacity: 0 },
          { transform: `translate(${x}px, -1px) scale(0.75)`, opacity: 0.9 },
          { transform: `translate(${x}px, -5px) scale(0.7)`, opacity: 0 },
        ]);
      }
      return transform(['rotate(0)', 'translateY(-2px) rotate(-18deg)', 'translateY(1px) rotate(15deg)',
        'translateY(-2px) rotate(-12deg)', 'rotate(0)']);
    }
    case 'btn-attach': {
      const layer = decorate('attachment', '<circle cx="12" cy="12" r="9"/><path data-plus d="M12 7v10m-5-5h10"/>');
      part(layer, '[data-plus]', [{ transform: 'rotate(0deg)' }, { transform: 'rotate(180deg)' }]);
      return replaceGlyph();
    }
    case 'btn-emoji': {
      const layer = decorate('laugh', '<circle cx="12" cy="12" r="9"/>'
        + '<path d="m6 9 2-1 2 1m4 0 2-1 2 1"/><path data-mouth d="M7 13h10c0 6-10 6-10 0Z"/>');
      part(layer, '[data-mouth]', [
        { transform: 'scaleY(0.4)' }, { transform: 'scaleY(1)' }, { transform: 'scaleY(0.6)' },
        { transform: 'scaleY(1)' }, { transform: 'scaleY(0.6)' },
      ]);
      play(layer.querySelector('svg')!, [
        { transform: 'rotate(0)' }, { transform: 'translateY(-2px) rotate(-10deg)' },
        { transform: 'translateY(1px) rotate(10deg)' }, { transform: 'translateY(-2px) rotate(-8deg)' },
        { transform: 'rotate(0)' },
      ], 760);
      return replaceGlyph();
    }
    case 'btn-code': {
      const layer = decorate('code', '<path data-left d="m8 6-5 6 5 6"/><path data-right d="m16 6 5 6-5 6"/>'
        + '<path data-cursor d="M12 8v8"/>');
      part(layer, '[data-left]', [{ transform: 'translateX(0)' }, { transform: 'translateX(-2px)' }, { transform: 'translateX(0)' }]);
      part(layer, '[data-right]', [{ transform: 'translateX(0)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(0)' }]);
      part(layer, '[data-cursor]', [
        { opacity: 0 }, { opacity: 1 }, { opacity: 0 }, { opacity: 1 }, { opacity: 0 },
      ]);
      return replaceGlyph();
    }
    case 'bar-btn-disconnect':
      return transform(['translateX(0)', 'translateX(3px)', 'translateX(0)'], 520);
    default:
      return transform(['translateY(0)', 'translateY(-3px)', 'translateY(0)'], 480);
  }
}
