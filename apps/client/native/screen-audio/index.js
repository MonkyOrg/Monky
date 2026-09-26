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

function start(options, callback) {
  if (!binding) return { success: false, error: 'Native module not available' };
  return binding.start(options, callback);
}

function stop() {
  if (!binding) return { success: false };
  return binding.stop();
}

function getLastError() {
  if (!binding) return '';
  return binding.getLastError();
}

function getStatus() {
  if (!binding) return 0;
  return binding.getStatus();
}

const { createPacketCaptureFactory } = require('./packet_capture');
const createPacketCapture = createPacketCaptureFactory(binding, process.platform);
function isPacketCaptureSupported() {
  return process.platform === 'win32' && !!binding && typeof binding.createPacketCapture === 'function' && binding.isSupported();
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
  isSupported, isPacketCaptureSupported, start, stop, getLastError, getStatus, createPacketCapture,
  listWindowOwners, listWindows, restoreWindow, getWindowState, getKeyboardLayout, listMonitors, getMonitorState,
  setWindowResizeAspect,
};
