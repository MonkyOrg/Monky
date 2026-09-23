'use strict';

if (location.hash === '#source') {
  const canvas = document.getElementById('source'), context = canvas.getContext('2d');
  canvas.hidden = false;
  let frames = 0;
  function paint() {
    context.fillStyle = '#ff00ff'; context.fillRect(0, 0, 800, 600);
    context.fillStyle = '#ff0000'; context.fillRect(0, 0, 800, 60);
    context.fillStyle = '#0000ff'; context.fillRect(0, 540, 800, 60);
    context.fillStyle = '#ffffff'; context.fillRect(300, 225, 200, 150);
    context.fillStyle = '#00ff00'; context.fillRect(100 + (frames++ % 600), 130, 12, 45);
    requestAnimationFrame(paint);
  }
  paint();
} else {
  document.getElementById('screen-smoke-video').hidden = false;
}
