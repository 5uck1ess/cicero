import { expect, test } from "bun:test";
import { presentedToken, tokenMatches } from "../src/http-auth";

test("empty configured tokens fail closed when credentials are absent", () => {
  expect(tokenMatches("", "")).toBe(false);
  expect(tokenMatches("anything", "")).toBe(false);
  expect(tokenMatches("", "configured-secret")).toBe(false);
});

test("non-empty bearer and query credentials still authenticate exactly", () => {
  expect(tokenMatches("configured-secret", "configured-secret")).toBe(true);
  expect(tokenMatches("configured-secret-x", "configured-secret")).toBe(false);

  const bearer = new Request("https://voice.local/", {
    headers: { Authorization: "Bearer configured-secret" },
  });
  expect(presentedToken(bearer, new URL(bearer.url))).toBe("configured-secret");

  const query = new Request("https://voice.local/?token=configured-secret");
  expect(presentedToken(query, new URL(query.url))).toBe("configured-secret");
});
