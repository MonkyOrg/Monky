/** @type {keyof import('@monky/shared').IpcInvokeChannels} */
const identitySignChannel = 'identity:sign-challenge';

module.exports = { identitySignChannel };

if (process.type === 'renderer') {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('voiceActivityIdentity', {
    signChallenge: nonce => ipcRenderer.invoke(identitySignChannel, nonce),
  });
}
