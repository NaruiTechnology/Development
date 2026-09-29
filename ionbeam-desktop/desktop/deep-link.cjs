const modes = new Set(['raster', 'vector', 'roi']);
function scanMode(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'ionbeam:' || url.hostname !== 'scan' ||
        !['', '/'].includes(url.pathname) || url.username || url.password || url.port || url.hash) return null;
    if ([...url.searchParams.keys()].some(key => key !== 'mode') || url.searchParams.getAll('mode').length > 1) return null;
    const mode = url.searchParams.get('mode') || 'raster';
    return modes.has(mode) ? mode : null;
  } catch { return null; }
}
module.exports = { scanMode };
