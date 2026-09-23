const glyphSelector = ':scope > .audio-state-icon, :scope > .material-symbols-outlined';

/** Observe only the footer controls, including changes made by native shortcuts. */
export function bindFooterControlsMotion(root: HTMLElement): () => void {
  return bindControlGlyphMotion(Array.from(root.querySelectorAll<HTMLButtonElement>(
    '.user-control-bar .user-quick-actions button, '
      + '.user-control-bar .user-media-bar button:is(#media-btn-camera, #media-btn-screen, #media-btn-soundboard)',
  )));
}

export function bindChatComposerMotion(root: HTMLElement): () => void {
  return bindControlGlyphMotion(Array.from(root.querySelectorAll<HTMLButtonElement>(
    '.chat-input-container .chat-input-wrapper > button:is(#btn-attach, #btn-emoji, #btn-code)',
  )));
}

export function bindStageControlsMotion(root: HTMLElement): () => void {
  const selector = '.voice-stage-container button';
  return bindControlGlyphMotion(Array.from(root.querySelectorAll<HTMLButtonElement>(selector)), { root, selector });
}

function bindControlGlyphMotion(
  controls: HTMLButtonElement[],
  dynamic?: { root: HTMLElement; selector: string },
): () => void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motions = new Map<HTMLButtonElement, { animations: Animation[]; decoration?: HTMLElement }>();
  const unbind = new Map<HTMLButtonElement, () => void>();
  const signature = (button: HTMLButtonElement) => [
    button.querySelector(glyphSelector)?.textContent?.trim(),
    button.querySelector('[data-audio-block]')?.hasAttribute('hidden'),
    button.dataset.state, button.dataset.ptt, button.dataset.pressed,
    button.getAttribute('aria-expanded'),
    button.classList.contains('danger-active'), button.classList.contains('active'),
  ].join('|');
  const states = new Map<HTMLButtonElement, string>();

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
    if (reducedMotion.matches || button.disabled || button.hidden || button.style.display === 'none'
      || !button.isConnected || !glyph) return;
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
      // Text buttons need the artwork over the glyph, not over the label.
      layer.style.inset = `${glyph.offsetTop}px auto auto ${glyph.offsetLeft}px`;
      layer.style.width = `${glyph.offsetWidth}px`;
      layer.style.height = `${glyph.offsetHeight}px`;
      layer.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round" focusable="false">${content}</svg>`;
      button.append(layer);
      motion.decoration = layer;
      return layer;
    };
    // The wrapper preserves PTT's vertical offset and keeps the prohibition badge intact.
    const animation = hover ? playHover(glyph, play, decorate) : play(glyph, [
      { transform: 'scale(0.88)' },
      { transform: 'scale(1)' },
    ], 140);
    animation.onfinish = () => cancel(button);
  };
  const bind = (button: HTMLButtonElement) => {
    states.set(button, signature(button));
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') animate(button, true);
    };
    const focus = () => {
      if (button.matches(':focus-visible')) animate(button, true);
    };
    const click = () => {
      states.set(button, signature(button));
      animate(button);
    };
    const leave = () => cancel(button);
    button.addEventListener('pointerenter', enter);
    button.addEventListener('pointerleave', leave);
    button.addEventListener('focus', focus);
    button.addEventListener('blur', leave);
    button.addEventListener('click', click);
    unbind.set(button, () => {
      button.removeEventListener('pointerenter', enter);
      button.removeEventListener('pointerleave', leave);
      button.removeEventListener('focus', focus);
      button.removeEventListener('blur', leave);
      button.removeEventListener('click', click);
    });
  };
  const observer = new MutationObserver((records) => {
    // Participant cards and the broadcast banner are replaced independently of the call bar.
    if (dynamic && records.some((record) => record.type === 'childList')) {
      const nextControls = new Set(dynamic.root.querySelectorAll<HTMLButtonElement>(dynamic.selector));
      for (const button of controls) {
        if (nextControls.has(button)) continue;
        cancel(button);
        unbind.get(button)?.();
        unbind.delete(button);
        states.delete(button);
      }
      for (const button of nextControls) {
        if (!unbind.has(button)) bind(button);
      }
      controls = Array.from(nextControls);
    }
    for (const button of controls) {
      if (button.disabled || button.hidden || button.style.display === 'none' || !button.isConnected) cancel(button);
      const next = signature(button);
      if (states.get(button) === next) continue;
      states.set(button, next);
      animate(button);
    }
  });
  const observation: MutationObserverInit = {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'disabled', 'data-state', 'data-ptt', 'data-pressed', 'aria-expanded', 'style'],
  };
  for (const button of controls) {
    bind(button);
    if (!dynamic) observer.observe(button, observation);
  }
  if (dynamic) observer.observe(dynamic.root, observation);
  const stopMotion = () => {
    if (reducedMotion.matches) controls.forEach(cancel);
  };
  reducedMotion.addEventListener('change', stopMotion);
  return () => {
    observer.disconnect();
    reducedMotion.removeEventListener('change', stopMotion);
    unbind.forEach((off) => off());
    unbind.clear();
    controls.forEach(cancel);
    states.clear();
  };
}

type Play = (target: Element, frames: Keyframe[], duration: number) => Animation;
type Decorate = (kind: string, content: string) => HTMLElement;

function playHover(glyph: HTMLElement, play: Play, decorate: Decorate): Animation {
  const transform = (values: string[], duration = 760) =>
    play(glyph, values.map((value) => ({ transform: value })), duration);
  const part = (layer: HTMLElement, selector: string, frames: Keyframe[], duration = 760) => {
    const element = layer.querySelector(selector);
    if (element) play(element, frames, duration);
  };
  const replaceGlyph = () => play(glyph, [{ opacity: 0 }, { opacity: 0 }], 760);
  const crossfadeGlyph = (layer: HTMLElement) => {
    const frames = [
      { offset: 0, opacity: 0 }, { offset: 0.12, opacity: 1 },
      { offset: 0.72, opacity: 1 }, { offset: 1, opacity: 0 },
    ];
    play(layer, frames, 760);
    return play(glyph, frames.map(({ offset, opacity }) => ({ offset, opacity: 1 - opacity })), 760);
  };
  const icon = glyph.querySelector('[data-audio-icon]') ?? glyph;
  switch (icon.textContent?.trim()) {
    case 'mic':
    case 'mic_off':
    case 'keyboard_voice':
      return transform(['rotate(0deg)', 'translateY(-2px) rotate(-22deg)', 'rotate(16deg)',
        'translateY(-1px) rotate(-12deg)', 'rotate(0deg)']);
    case 'headphones':
    case 'headset_off':
      return transform(['scale(1)', 'translateY(-2px) scale(1.15, 0.92)', 'translateY(1px) scale(0.94, 1.08)',
        'translateY(-2px) scale(1.1, 0.96)', 'scale(1)']);
    case 'settings':
      return transform(['rotate(0deg)', 'rotate(180deg)', 'rotate(360deg)'], 850);
    case 'videocam':
    case 'videocam_off': {
      // A monochrome, transient viewfinder, never a red "recording" status light.
      const layer = decorate('camera', '<path data-frame d="M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5"/>');
      part(layer, '[data-frame]', [
        { transform: 'scale(1.12)', opacity: 0 }, { transform: 'scale(0.92)', opacity: 1 },
        { transform: 'scale(1)', opacity: 0.35 }, { transform: 'scale(0.92)', opacity: 1 },
        { transform: 'scale(1.12)', opacity: 0 },
      ]);
      return transform(['scale(1)', 'scale(1.12)', 'scale(1)', 'scale(1.08)', 'scale(1)']);
    }
    case 'screen_share':
    case 'stop_screen_share': {
      const stopping = glyph.textContent?.trim() === 'stop_screen_share';
      const layer = decorate('screen', '<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8m-4-4v4"/>'
        + (stopping ? '<rect data-stop x="9" y="8" width="6" height="5" fill="currentColor" stroke="none"/>'
          : '<path data-arrow d="M12 14V7m-3 3 3-3 3 3"/>'));
      part(layer, stopping ? '[data-stop]' : '[data-arrow]', stopping ? [
        { opacity: 1 }, { opacity: 0.45 }, { opacity: 1 },
      ] : [
        { transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-2px)', opacity: 1 },
        { transform: 'translateY(1px)', opacity: 0.6 }, { transform: 'translateY(-2px)', opacity: 1 },
        { transform: 'translateY(0)', opacity: 1 },
      ]);
      return crossfadeGlyph(layer);
    }
    case 'picture_in_picture_alt': {
      const layer = decorate('overlay', '<rect x="2" y="3" width="20" height="16" rx="2"/>'
        + '<rect data-window x="12" y="11" width="9" height="7" rx="1" fill="currentColor" stroke="none"/>');
      part(layer, '[data-window]', [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: 'translate(-5px, -3px) scale(0.5)', opacity: 0.4 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: 'translate(-2px, -1px) scale(0.85)', opacity: 0.8 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      ]);
      return crossfadeGlyph(layer);
    }
    case 'music_note': {
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
    case 'add_circle': {
      const layer = decorate('attachment', '<circle cx="12" cy="12" r="9"/><path data-plus d="M12 7v10m-5-5h10"/>');
      part(layer, '[data-plus]', [{ transform: 'rotate(0deg)' }, { transform: 'rotate(180deg)' }]);
      return replaceGlyph();
    }
    case 'mood': {
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
    case 'code': {
      const layer = decorate('code', '<path data-left d="m8 6-5 6 5 6"/><path data-right d="m16 6 5 6-5 6"/>'
        + '<path data-cursor d="M12 8v8"/>');
      part(layer, '[data-left]', [{ transform: 'translateX(0)' }, { transform: 'translateX(-2px)' }, { transform: 'translateX(0)' }]);
      part(layer, '[data-right]', [{ transform: 'translateX(0)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(0)' }]);
      part(layer, '[data-cursor]', [
        { opacity: 0 }, { opacity: 1 }, { opacity: 0 }, { opacity: 1 }, { opacity: 0 },
      ]);
      return replaceGlyph();
    }
    case 'smart_display': {
      const layer = decorate('watch', '<rect x="2" y="4" width="20" height="16" rx="2"/>'
        + '<path data-play d="m10 8 6 4-6 4Z" fill="currentColor" stroke="none"/>');
      part(layer, '[data-play]', [
        { transform: 'translateX(-1px)', opacity: 0.5 },
        { transform: 'translateX(2px)', opacity: 1 },
        { transform: 'translateX(0)', opacity: 1 },
      ]);
      return replaceGlyph();
    }
    case 'visibility_off':
      return transform(['scaleY(1)', 'scaleY(0.25)', 'scaleY(1)', 'scaleY(0.6)', 'scaleY(1)']);
    case 'volume_up':
    case 'volume_off': {
      const muted = icon.textContent?.trim() === 'volume_off';
      const layer = decorate('volume', '<path d="M11 5 6 9H3v6h3l5 4Z"/>'
        + (muted ? '<path data-mute d="m16 9 6 6m0-6-6 6"/>'
          : '<path data-wave-inner d="M15 8a5 5 0 0 1 0 8"/><path data-wave-outer d="M18 5a9 9 0 0 1 0 14"/>'));
      if (muted) {
        part(layer, '[data-mute]', [
          { transform: 'scale(1)' }, { transform: 'scale(0.75)' },
          { transform: 'scale(1.1)' }, { transform: 'scale(1)' },
        ]);
      } else {
        for (const [selector, distance] of [['[data-wave-inner]', 1], ['[data-wave-outer]', 2]] as const) {
          part(layer, selector, [
            { transform: 'translateX(-1px)', opacity: 0.35 },
            { transform: `translateX(${distance}px)`, opacity: 1 },
            { transform: 'translateX(0)', opacity: 0.5 },
            { transform: `translateX(${distance}px)`, opacity: 1 },
            { transform: 'translateX(0)', opacity: 1 },
          ]);
        }
      }
      return replaceGlyph();
    }
    case 'fullscreen': {
      const layer = decorate('fullscreen', '<path data-top-left d="M9 4H4v5"/><path data-top-right d="M15 4h5v5"/>'
        + '<path data-bottom-left d="M4 15v5h5"/><path data-bottom-right d="M20 15v5h-5"/>');
      for (const [selector, x, y] of [
        ['[data-top-left]', -2, -2], ['[data-top-right]', 2, -2],
        ['[data-bottom-left]', -2, 2], ['[data-bottom-right]', 2, 2],
      ] as const) {
        part(layer, selector, [
          { transform: 'translate(0, 0)' }, { transform: `translate(${x}px, ${y}px)` },
          { transform: 'translate(0, 0)' },
        ]);
      }
      return replaceGlyph();
    }
    case 'stop_circle': {
      const layer = decorate('stop', '<circle cx="12" cy="12" r="9"/>'
        + '<rect data-stop x="8" y="8" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>');
      part(layer, '[data-stop]', [
        { transform: 'scale(1)' }, { transform: 'scale(0.7)' },
        { transform: 'scale(1.1)' }, { transform: 'scale(1)' },
      ]);
      return replaceGlyph();
    }
    case 'call_end':
      return transform(['translateY(0) rotate(0)', 'translateY(-2px) rotate(-12deg)',
        'translateY(3px) rotate(0)', 'translateY(0) rotate(0)'], 620);
    case 'logout':
      return transform(['translateX(0)', 'translateX(3px)', 'translateX(0)'], 520);
    default:
      return transform(['translateY(0)', 'translateY(-3px)', 'translateY(0)'], 480);
  }
}
