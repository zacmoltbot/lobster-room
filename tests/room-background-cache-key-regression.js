const assert = require('assert');

function roomImageCacheKey(info) {
  const roomId = (info && info.roomId) ? String(info.roomId) : 'default';
  const updatedAt = (info && info.updatedAt) ? info.updatedAt : 0;
  return encodeURIComponent(roomId) + ':' + String(updatedAt);
}

{
  const a = roomImageCacheKey({ roomId: 'room-1', updatedAt: 1775645727676 });
  const b = roomImageCacheKey({ roomId: 'room-2', updatedAt: 1775645727676 });
  assert.notEqual(a, b, 'switching rooms must change the immutable image cache key even when updatedAt is identical');
}

{
  const a = roomImageCacheKey({ roomId: 'default', updatedAt: 0 });
  const b = roomImageCacheKey({ roomId: 'default', updatedAt: 123 });
  assert.notEqual(a, b, 'same room with a new image revision must still invalidate cache');
}

console.log('room-background-cache-key-regression: PASS');
