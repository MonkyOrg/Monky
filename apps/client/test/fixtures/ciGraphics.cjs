module.exports = function configureCiGraphics(app) {
  if (process.env.CI !== 'true') return;
  // Exercise real shaders with each hosted runner's supported backend.
  const angle = process.platform === 'darwin' ? 'metal'
    : process.platform === 'win32' ? 'd3d11-warp' : 'swiftshader';
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', angle);
  if (angle === 'swiftshader') app.commandLine.appendSwitch('enable-unsafe-swiftshader');
};
