const { contextBridge, ipcRenderer } = require('electron');
const { AUDIO_PREVIEW_IPC } = require('@monky/shared');

contextBridge.exposeInMainWorld('localExecutionFixture', {
  loadAudioPreview: input => ipcRenderer.invoke(AUDIO_PREVIEW_IPC.load, input),
  cancelAudioPreview: input => ipcRenderer.invoke(AUDIO_PREVIEW_IPC.cancel, input),
});
