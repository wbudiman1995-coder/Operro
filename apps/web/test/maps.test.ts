import assert from "node:assert/strict";
import test from "node:test";

import { isSupportedShortMapsUrl, parseMapCoordinates } from "../src/lib/maps";

test("parses common Google Maps coordinate formats", () => {
  assert.deepEqual(parseMapCoordinates("https://google.com/maps/place/x/@-6.1592,106.9093,17z"), { latitude: -6.1592, longitude: 106.9093 });
  assert.deepEqual(parseMapCoordinates("https://google.com/maps?q=-6.2%2C106.8"), { latitude: -6.2, longitude: 106.8 });
  assert.deepEqual(parseMapCoordinates("-6.21, 106.82"), { latitude: -6.21, longitude: 106.82 });
  assert.equal(parseMapCoordinates("91, 106.82"), null);
});

test("only recognizes allow-listed Google short-link hosts", () => {
  assert.equal(isSupportedShortMapsUrl("https://maps.app.goo.gl/abc"), true);
  assert.equal(isSupportedShortMapsUrl("share.google/abc"), true);
  assert.equal(isSupportedShortMapsUrl("https://example.com/maps.app.goo.gl/abc"), false);
});
