'use strict';

const fs = require('node:fs');
const path = require('node:path');

const license = 'GPL-3.0-or-later';
const root = path.resolve(__dirname, '..');

function copyMonkyLicenses(destination) {
  for (const name of ['LICENSE', 'LICENSE-MIT'])
    fs.copyFileSync(path.join(root, name), path.join(destination, name));
}

module.exports = { license, copyMonkyLicenses };
