const path = require('node:path');

const platforms = { win32: 'windows', darwin: 'macos' };
const platform = platforms[process.platform];
if (!platform || !['x64', 'arm64'].includes(process.arch) ||
    (process.platform === 'win32' && process.arch !== 'x64')) {
  throw new Error(`Unsupported native test host: ${process.platform}/${process.arch}`);
}
const buildDirectory = path.resolve(__dirname, '..', 'build', `${platform}-${process.arch}`);

function nativeExecutable(name) {
  if (process.platform === 'darwin' && ['monky-light', 'monky-light-websocket-fixture'].includes(name)) {
    return path.join(buildDirectory, 'bin', `${name}.app`, 'Contents', 'MacOS', name);
  }
  return path.join(buildDirectory, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
}

module.exports = { buildDirectory, nativeExecutable };
