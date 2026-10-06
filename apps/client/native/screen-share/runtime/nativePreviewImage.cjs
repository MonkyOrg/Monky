'use strict';
const assert = require('node:assert/strict');
const { crc32 } = require('node:zlib');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validatePreviewImage(image, width, height) {
  assert.ok(Buffer.isBuffer(image) && image.length >= 45 && image.length <= 1024 * 1024);
  assert.ok(image.subarray(0, 8).equals(signature), 'Native preview is not a PNG.');
  let at = 8, chunks = 0, data = false, ended = false;
  while (at < image.length) {
    assert.ok(++chunks <= 256 && at + 12 <= image.length, 'Native preview PNG is truncated.');
    const bytes = image.readUInt32BE(at), type = image.toString('ascii', at + 4, at + 8);
    assert.ok(bytes <= image.length - at - 12);
    const end = at + bytes + 12;
    assert.equal(crc32(image.subarray(at + 4, end - 4)), image.readUInt32BE(end - 4),
      'Native preview PNG checksum is invalid.');
    if (chunks === 1) {
      assert.equal(type, 'IHDR'); assert.equal(bytes, 13);
      assert.ok(image.readUInt32BE(at + 8) > 0 && image.readUInt32BE(at + 8) <= width);
      assert.ok(image.readUInt32BE(at + 12) > 0 && image.readUInt32BE(at + 12) <= height);
    } else assert.notEqual(type, 'IHDR');
    if (type === 'IDAT') data = true;
    if (type === 'IEND') {
      assert.equal(bytes, 0);
      assert.equal(end, image.length);
      ended = true;
    }
    at = end;
  }
  assert.ok(data && ended, 'Native preview PNG has no complete image.');
  return image;
}
module.exports = { validatePreviewImage };
