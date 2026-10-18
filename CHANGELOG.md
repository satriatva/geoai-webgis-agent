# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-10-18

### Added

- `find_places_along_route` tool for "what is on the way from A to B" questions. It gets the car route from OSRM, searches a corridor along it (50 to 1000 m, default 300 m) for up to three place categories, and lists the places in travel order with their distance along the route and from the road. Routes are limited to 50 km.
- `OSRM_URL` setting. The default is the public OSRM demo server, called at most once per second.
- Map symbology for routes: a solid route line, its corridor, the route ends and a Route entry in the legend.
- Along-route results show their position as a road kilometre ("km 2.4") in the result list, and "km along the route, m off it" in their popup.
- Example question on the start screen: "What cafes and fuel stations are on the way from Monas to Blok M?".
- Offline tests for the along-route search, bringing the suite to 53 tests.
- This changelog.

### Changed

- The system prompt sends route questions to the new tool and tells the model which distances are straight-line and which follow the road.
- The Overpass request and the parsing of its results are shared by the nearby and along-route searches (`runOverpass`, `elementToPlace` in `src/tools/places.js`). Nearby search behaves as before.
- Result list rows are at least 44 px tall on mobile, so they are easier to tap.
- README and setup guide describe the new tool, the `OSRM_URL` setting and its error messages. The start-screen screenshots are retaken for the new example question, and two along-route screenshots are added.

### Fixed

- The demo video link added to the README on 2026-10-07 rendered as a broken nested link. The hosted video URL now sits on its own line.

## [1.0.0] - 2026-10-07

### Added

- First release: an LLM tool-calling agent with geocoding, reverse geocoding, nearby search, distance and buffer tools on OpenStreetMap (Nominatim, Overpass API, Turf.js).
- Leaflet web client with a live tool trace, clickable results, light and dark themes and a mobile layout.
- Google Gemini and OpenAI-compatible providers (OpenAI, Groq, OpenRouter, Ollama, LM Studio, vLLM).
- Offline test suite and GitHub Actions CI on Node 20 and 22.

[Unreleased]: https://github.com/satriatva/geoai-webgis-agent/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/satriatva/geoai-webgis-agent/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/satriatva/geoai-webgis-agent/releases/tag/v1.0.0
