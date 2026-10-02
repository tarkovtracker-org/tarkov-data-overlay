// fallow-ignore-file security-sink
// Reviewed false positive: the requested origin is a literal and the path below
// admits only known endpoints under a safe mode name. No caller can select a
// host, query, fragment, or traversal path. Keep this policy isolated so security
// candidates in the API adapter remain visible. Native redirects retain the
// upstream service's existing behavior.
async function fetchTarkovJson(path, signal) {
  if (
    typeof path !== 'string' ||
    !/^(?:endpoints|[a-z0-9]+(?:-[a-z0-9]+)*\/(?:tasks|items|maps|traders)(?:_en)?)$/.test(path)
  ) {
    const error = new Error('Invalid tarkov.dev endpoint');
    error.fatal = true;
    throw error;
  }
  return fetch(`https://json.tarkov.dev/${path}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent':
        'tarkov-data-overlay (+https://github.com/tarkovtracker-org/tarkov-data-overlay)',
    },
    signal,
  });
}

module.exports = { fetchTarkovJson };
