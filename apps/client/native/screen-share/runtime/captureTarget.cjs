'use strict';

const { validateSource } = require('./captureProtocol.cjs');
const { validateMacTarget } = require('./mac/target.cjs');

function validateCaptureTarget(target) {
  return target?.platform === 'darwin' ? validateMacTarget(target) : validateSource(target);
}

module.exports = { validateCaptureTarget };
