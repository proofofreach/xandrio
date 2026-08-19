// Single source of truth for "this path can trigger TTS synthesis work".
//
// lib/rate-limit.js and lib/concurrency-limit.js each meter this same set of
// routes, but as two independently hand-maintained regexes they had already
// drifted once (the guide-narration audio route was in the concurrency list
// but missing from the rate-limit list, leaving it with no request-rate
// ceiling at all). Exporting one pattern both modules attach their own limits
// to means a newly added TTS route can't be added to one list and forgotten
// in the other.
const TTS_ROUTE_PATTERN = /^\/api\/(?:audio(?:-ios|-chunked|-continuous)?\/|book\/[^/]+\/guide\/narration\/[^/]+\/audio$|voice-sample\/|chunks\/(?:[^/]+\/\d+\/(?:\d+|prepare|retry|prepare-chapter-audio))$|offline\/preparation\/[^/]+$|premium-prep\/.*\/start$)/;

function isTtsRoute(path) {
  return TTS_ROUTE_PATTERN.test(path);
}

module.exports = { TTS_ROUTE_PATTERN, isTtsRoute };
