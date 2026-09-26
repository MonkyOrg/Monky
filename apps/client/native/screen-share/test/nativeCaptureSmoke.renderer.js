'use strict';

if (location.hash === '#source') {
  const canvas = document.getElementById('source'), context = canvas.getContext('2d');
  canvas.hidden = false;
  let frames = 0;
  const paintTasks = new MessageChannel();
  paintTasks.port1.onmessage = paint;
  globalThis.nativeCaptureSourceSample = () => ({ frames, at: performance.now() });
  function paint() {
    context.fillStyle = '#ff00ff'; context.fillRect(0, 0, 800, 600);
    context.fillStyle = '#ff0000'; context.fillRect(0, 0, 800, 60);
    context.fillStyle = '#0000ff'; context.fillRect(0, 540, 800, 60);
    context.fillStyle = '#ffffff'; context.fillRect(300, 225, 200, 150);
    context.fillStyle = '#00ff00'; context.fillRect(100 + (frames++ % 600), 130, 12, 45);
    for (let bit = 0; bit < 16; bit++) {
      context.fillStyle = (frames >> bit) & 1 ? '#ffffff' : '#000000';
      context.fillRect(200 + bit * 24, 190, 24, 24);
    }
    // A message task resets timer nesting: supply fresh frames above 240 FPS
    // without RAF/vsync coupling or thousands of redundant canvas commits.
    setTimeout(() => paintTasks.port2.postMessage(null), 2);
  }
  paint();
} else {
  document.getElementById('screen-smoke-video').hidden = false;
}
