'use strict';

// Validation of a capture target, for Main code that lists or resolves sources
// before anything is captured: loading it never parses capture, transport or
// presentation (#851).
const { validateCaptureTarget } = require('./runtime/captureTarget.cjs');

module.exports = { validateCaptureTarget };
