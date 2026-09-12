module.exports = { runColorPickerSmoke, renderColorPickerPreview };

async function runColorPickerSmoke() {
  const [{ ColorPicker }, { ScreenColorPickerError }, language] = await Promise.all([
    import('/views/ColorPicker.ts'), import('/core/ScreenColorPicker.ts'), import('/i18n/index.ts'),
    import('/styles/fonts.css'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const wait = () => new Promise(resolve => setTimeout(resolve, 30));
  const previousLanguage = language.getLanguage();
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;left:20px;top:20px;width:340px;height:160px;overflow:hidden;padding:12px';
  let saved = '#ff0000';
  let pending = 0;
  const selections = [];
  let samples = 0;
  let sampler = async () => '#A1B2C3';
  const provider = { isAvailable: () => true, pick: signal => { samples++; return sampler(signal); } };
  const first = new ColorPicker({ id: 'color-fixture-first', label: 'cameraEffects.keyColor' }, provider);
  const second = new ColorPicker({ id: 'color-fixture-second', label: 'roles.roleColor' }, provider);
  const unavailable = new ColorPicker({ id: 'color-fixture-unavailable', label: 'cameraEffects.backgroundColor' }, {
    isAvailable: () => false, pick: async () => { throw new Error('Unavailable provider must never be called'); },
  });
  language.setLanguage('pt-BR');
  root.innerHTML = first.renderHtml(saved) + second.renderHtml('#5865f2') + unavailable.renderHtml('#ffffff')
    + '<button data-color-outside>outside</button>';
  document.body.append(root);
  first.attachEvents(root, color => {
    selections.push(color);
    pending++;
    first.setValue(saved, true);
    queueMicrotask(() => { saved = color; pending--; first.setValue(saved, pending > 0); });
  });
  second.attachEvents(root, color => second.setValue(color));
  unavailable.attachEvents(root, color => unavailable.setValue(color));
  const trigger = () => root.querySelector('#color-fixture-first');
  const popup = () => root.querySelector('.color-picker-popover');
  const field = name => popup().querySelector(`[data-color-${name}]`);
  const open = () => { trigger().click(); return popup(); };
  const typeHex = value => { field('hex').value = value; field('hex').dispatchEvent(new Event('input', { bubbles: true })); };
  const outside = () => root.querySelector('[data-color-outside]').dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  let parentEscapes = 0;
  const parentKeys = event => { if (event.key === 'Escape') parentEscapes++; };
  document.addEventListener('keydown', parentKeys, true);
  try {
    open();
    check(popup().matches(':popover-open') && first.isOpen && !root.querySelector('input[type=color]'),
      'The reusable color control opens its own non-native top-layer picker');
    check(trigger().getAttribute('aria-expanded') === 'true'
      && document.getElementById(trigger().getAttribute('aria-controls')) === popup(),
      'The trigger has a working dialog relationship');
    check(popup().getAttribute('aria-label').includes(language.t('cameraEffects.keyColor')),
      'Picker title and accessible name follow the current locale');
    check(field('saturation').type === 'range' && field('brightness').type === 'range'
      && field('hue').type === 'range' && field('hex').getAttribute('aria-label'),
      'Both dimensions, hue and exact color entry are keyboard accessible');
    check(samples === 0, 'Opening, focusing and rendering never start screen sampling');
    await wait();
    check(popup().getBoundingClientRect().bottom > root.getBoundingClientRect().bottom,
      'The nested top-layer picker is not clipped by its scrolling owner');
    typeHex('0f0');
    check(selections.length === 0, 'Typing a draft does not send intermediate colors');
    outside();
    check(!first.isOpen && trigger().value === '#00ff00',
      'An outside click commits the current draft before an owner can refresh or close');
    await wait();
    check(saved === '#00ff00' && selections.at(-1) === '#00ff00',
      'The immutable selected color survives a synchronous stale owner refresh');
    open();
    check(field('hex').value === '#00FF00', 'Reopening retains the selected color');
    typeHex('#broken');
    const beforeInvalid = selections.length;
    outside();
    check(first.isOpen && field('hex').getAttribute('aria-invalid') === 'true'
      && !field('error').hidden && selections.length === beforeInvalid,
      'Malformed HEX has an explicit error instead of disappearing or being applied');
    escape();
    check(!first.isOpen && parentEscapes === 0 && trigger().value === saved,
      'Escape discards only the unfinished entry and does not close the parent dialog');
    open();
    for (const [axis, value, expected] of [['hue', 240, '#0000ff'], ['saturation', 50, '#8080ff'], ['brightness', 40, '#333366']]) {
      const input = field(axis);
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await wait();
      check(saved === expected && input.getAttribute('aria-valuetext'), `${axis} selects the expected exact color`);
    }
    const presets = popup().querySelectorAll('[data-color-preset]');
    presets[0].click();
    presets[1].click();
    await wait();
    check(saved === presets[1].dataset.colorPreset && trigger().value === saved,
      'Rapid preset choices converge on the last selection without stale rollback');
    typeHex('#123abc');
    field('close').click();
    await wait();
    check(!first.isOpen && saved === '#123abc', 'The close button also keeps a valid HEX choice');
    open();
    field('eyedropper').click();
    await wait();
    check(saved === '#a1b2c3' && samples === 1 && first.isOpen,
      'An explicit eyedropper result is normalized and applied through the same controlled value');
    let resolveSample;
    let samplingSignal;
    sampler = signal => { samplingSignal = signal; return new Promise(resolve => { resolveSample = resolve; }); };
    field('eyedropper').click();
    check(samplingSignal && !samplingSignal.aborted && popup().classList.contains('color-picker-sampling'),
      'Eyedropper gets its cancellation signal and the picker stops obscuring the underlying preview');
    escape();
    resolveSample('#ffaa00');
    await wait();
    check(samplingSignal.aborted && first.isOpen && !popup().classList.contains('color-picker-sampling')
      && saved === '#a1b2c3' && parentEscapes === 0,
      'Escape cancels only sampling and ignores a late result');
    for (const [code, key] of [
      ['unsupported', 'colorPicker.unsupported'], ['permission', 'colorPicker.permission'],
      ['capture', 'colorPicker.captureFailed'], ['busy', 'colorPicker.busy'],
    ]) {
      sampler = async () => { throw new ScreenColorPickerError(code); };
      field('eyedropper').click();
      await wait();
      check(field('error').textContent === language.t(key) && saved === '#a1b2c3',
        `${code} sampling failure is explicit and preserves the selected color`);
    }
    sampler = signal => { samplingSignal = signal; return new Promise(resolve => { resolveSample = resolve; }); };
    field('eyedropper').click();
    first.close(false, false);
    resolveSample('#abcdef');
    await wait();
    check(samplingSignal.aborted && !first.isOpen && saved === '#a1b2c3',
      'Closing a picker cancels sampling and prevents late changes to its former owner');
    open();
    typeHex('#456789');
    root.querySelector('#color-fixture-second').click();
    await wait();
    check(saved === '#456789' && !first.isOpen && second.isOpen
      && document.querySelectorAll('.color-picker-popover').length === 1,
      'Opening another picker commits the first valid selection and keeps only one popup');
    second.close();
    root.querySelector('#color-fixture-unavailable').click();
    check(popup().querySelector('[data-color-eyedropper]').disabled
      && popup().textContent.includes(language.t('colorPicker.unsupported')),
      'Unsupported environments keep manual color selection and clearly disable sampling');
    unavailable.close();
    open();
    first.setDisabled(true);
    check(!first.isOpen && trigger().disabled, 'Permission/loading disable closes the managed picker');
    first.setDisabled(false);
    open();
    root.style.display = 'none';
    await wait();
    check(!first.isOpen, 'Hiding the owning settings section removes the popup');
    root.style.display = '';
    language.setLanguage('en');
    open();
    check(popup().textContent.includes('Eyedropper') && popup().getAttribute('aria-label').startsWith('Choose color:'),
      'Reopened color controls and failure hints use English when selected');
    root.remove();
    await wait();
    check(!first.isOpen && !document.querySelector('.color-picker-popover'),
      'Unmounting the owner releases the top-layer popup and its observers');
    document.body.append(root);
    first.attachEvents(root, () => { first.cleanup(); root.remove(); });
    open();
    typeHex('#12ab34');
    field('close').click();
    check(!first.isOpen && !root.isConnected,
      'An owner may synchronously unmount during commit without a stale popup or null dereference');
    check(parentEscapes === 0, 'Nested keyboard handling never leaked an Escape into the owner');
  } finally {
    first.cleanup();
    second.cleanup();
    unavailable.cleanup();
    root.remove();
    document.removeEventListener('keydown', parentKeys, true);
    language.setLanguage(previousLanguage);
  }
  return checks;
}

async function renderColorPickerPreview() {
  const [{ ColorPicker }] = await Promise.all([import('/views/ColorPicker.ts'), import('/styles/fonts.css')]);
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;left:48px;top:40px;width:360px;padding:20px;border:1px solid var(--border-color);border-radius:12px;background:var(--bg-card)';
  const picker = new ColorPicker({ id: 'color-native-fixture', label: 'cameraEffects.keyColor' }, {
    isAvailable: () => true, pick: async () => '#00ff00',
  });
  root.innerHTML = picker.renderHtml('#ff0000');
  document.body.append(root);
  window.colorFixtureSelections = [];
  picker.attachEvents(root, color => { window.colorFixtureSelections.push(color); picker.setValue(color); });
  root.querySelector('button').click();
  window.cleanupColorPickerPreview = () => {
    picker.cleanup();
    root.remove();
    delete window.colorFixtureSelections;
    delete window.cleanupColorPickerPreview;
  };
  await document.fonts.ready;
}
