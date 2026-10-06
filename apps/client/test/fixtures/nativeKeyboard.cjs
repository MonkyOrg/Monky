function nativeEditingCommands(code, modifiers, platform = process.platform) {
  if (platform !== 'darwin' || ![4, 12].includes(modifiers)) return [];
  // CDP bypasses Cocoa's key-binding resolver for native editable elements.
  const command = code === 'KeyZ' ? (modifiers === 12 ? 'redo' : 'undo')
    : code === 'KeyV' ? 'paste' : code === 'KeyC' && !(modifiers & 8) ? 'copy' : null;
  return command ? [command] : [];
}

async function dispatchKey(window, key, code, virtualKey, modifiers = 0, text) {
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', key, code, modifiers, windowsVirtualKeyCode: virtualKey,
    commands: nativeEditingCommands(code, modifiers),
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: virtualKey,
  });
}

module.exports = { nativeEditingCommands, dispatchKey };
