'use strict';

const { loadBinding, createScreenAudio } = require('./native_binding');

module.exports = createScreenAudio(loadBinding(require));