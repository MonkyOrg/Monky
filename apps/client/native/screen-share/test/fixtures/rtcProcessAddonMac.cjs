'use strict';

const { createEngine } = require('./rtcProcessAddon.cjs');
module.exports = {
  capabilities: () => ({ fixture: 'owned-rtc-process', decodedOutput: 'NV12_IOSURFACE_LEASE' }),
  createEngine,
};
