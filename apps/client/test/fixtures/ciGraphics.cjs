module.exports = function configureCiGraphics(app) {
  if (process.env.CI !== 'true') return;
  // Exercise real shaders with each hosted runner's supported backend.
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', process.platform === 'darwin' ? 'metal' : 'swiftshader');
  if (process.platform !== 'darwin') app.commandLine.appendSwitch('enable-unsafe-swiftshader');
};
