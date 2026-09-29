const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanMode } = require('../desktop/deep-link.cjs');
test('desktop URI accepts only supported scan tabs', () => {
  for (const mode of ['raster', 'vector', 'roi']) assert.equal(scanMode(`ionbeam://scan?mode=${mode}`), mode);
  assert.equal(scanMode('ionbeam://scan'), 'raster');
  for (const url of ['https://scan?mode=raster', 'ionbeam://scan?mode=vector&run=1', 'ionbeam://scan?mode=invalid',
    'ionbeam://user@scan?mode=raster', 'ionbeam://scan/path', 'ionbeam://scan?mode=roi&mode=vector',
    'ionbeam://scan?auth=secret', 'ionbeam://scan#run']) assert.equal(scanMode(url), null);
});
