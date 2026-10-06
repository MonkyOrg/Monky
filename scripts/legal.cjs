'use strict';

const fs = require('node:fs');
const path = require('node:path');

const license = 'GPL-3.0-or-later';
const root = path.resolve(__dirname, '..');

function copyMonkyLicenses(destination) {
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'));
}

module.exports = { license, copyMonkyLicenses };
