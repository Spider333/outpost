import { test } from "node:test";
import assert from "node:assert/strict";
import { httpsUrl, initial, isImageEmbed } from "../src/web/media.js";

test("only https URLs are used for pictures", () => {
  assert.equal(httpsUrl("https://i.imgur.com/a.png"), "https://i.imgur.com/a.png");
  assert.equal(httpsUrl("  https://example.org/p  "), "https://example.org/p");
  for (const bad of ["http://i.imgur.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "ipfs://bafy", "//i.imgur.com/a.png", "not a url", "", undefined]) {
    assert.equal(httpsUrl(bad), undefined, String(bad));
  }
});

test("image embeds: image file paths and the Farcaster upload host", () => {
  assert.ok(isImageEmbed("https://i.imgur.com/abc.JPG"));
  assert.ok(isImageEmbed("https://example.org/x/photo.webp?w=600"));
  // Real upload from a mainnet cast: no extension.
  assert.ok(isImageEmbed("https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/54654af3-dd58-4b2c-9683-e7d2dc827800/original"));
  assert.ok(!isImageEmbed("https://www.word-a-day.com/help"));
  assert.ok(!isImageEmbed("https://example.org/a.png.html"));
  assert.ok(!isImageEmbed("http://example.org/a.png"));
  assert.ok(!isImageEmbed("https://farcaster.xyz/~/channel/dev"));
});

test("initial for a missing picture", () => {
  assert.equal(initial("dwr"), "D");
  assert.equal(initial("@greg"), "G");
  assert.equal(initial("  émile"), "É");
  assert.equal(initial("🦊 fox"), "🦊");
  assert.equal(initial(""), "#");
  assert.equal(initial(undefined), "#");
});
