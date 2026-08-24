import { describe, expect, it } from "vitest";
import { YoutubeAuthService } from "../src/infrastructure/youtube-auth.js";

describe("YouTube OAuth", () => {
  it("always requests offline upload access with fresh consent", () => {
    const auth = new YoutubeAuthService({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://example.com/oauth/youtube/callback",
      tokenStore: { get: async () => undefined, set: async () => undefined },
    });

    const url = new URL(auth.createAuthorizationUrl("telegram-user"));

    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/youtube.upload");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/youtube.readonly");
  });
});
