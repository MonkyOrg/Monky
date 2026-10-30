'use strict';

const path = require('path');

let binding;
try {
  binding = require('./build/Release/screen_audio.node');
} catch {
  try {
    binding = require('./build/Debug/screen_audio.node');
  } catch {
    binding = null;
  }
}

function isSupported() {
  if (!binding) return false;
  return binding.isSupported();
}

const { createPacketCaptureFactory } = require('./packet_capture');
const createPacketCapture = createPacketCaptureFactory(binding, process.platform);
function isPacketCaptureSupported() {
  return ['win32', 'darwin'].includes(process.platform) && !!binding
    && typeof binding.createPacketCapture === 'function' && binding.isSupported();
}

function listWindowOwners() {
  if (!binding || typeof binding.listWindowOwners !== 'function') return [];
  return binding.listWindowOwners();
}

function listWindows() {
  if (!binding || typeof binding.listWindows !== 'function') return [];
  return binding.listWindows();
}

function restoreWindow(hwnd) {
  if (!binding || typeof binding.restoreWindow !== 'function') return false;
  return binding.restoreWindow(hwnd);
}

function getWindowState(hwnd) {
  if (!binding || typeof binding.getWindowState !== 'function')
    throw new Error('Native window lifecycle inspection is unavailable. Rebuild the native audio module.');
  return binding.getWindowState(hwnd);
}

function getProcessAncestry(processIds) {
  if (!binding || typeof binding.getProcessAncestry !== 'function')
    throw new Error('Native process inspection is unavailable. Rebuild the native audio module.');
  return binding.getProcessAncestry(processIds);
}

function getWindowOcclusion(hwnd) {
  if (!binding || typeof binding.getWindowOcclusion !== 'function') return null;
  return binding.getWindowOcclusion(hwnd);
}

function startWindowFrameProbe(hwnd) {
  if (!binding || typeof binding.startWindowFrameProbe !== 'function') return null;
  return binding.startWindowFrameProbe(hwnd);
}

function getWindowFrameProbe(id) {
  if (!binding || typeof binding.getWindowFrameProbe !== 'function') return null;
  return binding.getWindowFrameProbe(id);
}

function stopWindowFrameProbe(id) {
  if (!binding || typeof binding.stopWindowFrameProbe !== 'function') return false;
  return binding.stopWindowFrameProbe(id);
}

function listMonitors() {
  if (!binding || typeof binding.listMonitors !== 'function')
    throw new Error('Native monitor enumeration is unavailable. Rebuild the native audio module.');
  return binding.listMonitors();
}

function getMonitorState(deviceId) {
  if (!binding || typeof binding.getMonitorState !== 'function')
    throw new Error('Native monitor lifecycle inspection is unavailable. Rebuild the native audio module.');
  return binding.getMonitorState(deviceId);
}

function getKeyboardLayout(previousId = '', characters = '') {
  if (!binding || typeof binding.getKeyboardLayout !== 'function') return null;
  return binding.getKeyboardLayout(previousId, characters);
}

function setWindowResizeAspect(handle, ratio, extraWidth, extraHeight) {
  if (!binding || typeof binding.setWindowResizeAspect !== 'function')
    throw new Error('Native window resize constraints are unavailable. Rebuild the native audio module.');
  binding.setWindowResizeAspect(handle, ratio, extraWidth, extraHeight);
}

module.exports = {
  isSupported, isPacketCaptureSupported, createPacketCapture,
  listWindowOwners, listWindows, restoreWindow, getWindowState, getProcessAncestry, getWindowOcclusion, startWindowFrameProbe,
  getWindowFrameProbe, stopWindowFrameProbe, getKeyboardLayout, listMonitors,
  getMonitorState, setWindowResizeAspect,
};
