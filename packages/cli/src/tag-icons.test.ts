import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { generateTagIconPayloads } from "./tag-icons.js";

describe("setup-generated Discord tag icons", () => {
  it("renders every configured tag as a compact 128px PNG data URL", async () => {
    const icons = await generateTagIconPayloads({
      primaryColor: "#112233",
      accentColor: "#445566",
      priorities: [
        { id: "critical", color: "#AA0000" },
        { id: "high", color: "#FF8800" },
        { id: "medium", color: "#EAB308" },
        { id: "low", color: "#22C55E" },
      ],
      lifecycle: [
        { id: "inbox", color: "#64748B" },
        { id: "done", color: "#16A34A" },
      ],
    });

    expect(Object.keys(icons)).toEqual([
      "visual",
      "functionality",
      "critical",
      "high",
      "medium",
      "low",
      "inbox",
      "done",
    ]);
    for (const payload of Object.values(icons)) {
      expect(payload).toMatch(/^data:image\/png;base64,/);
      const image = Buffer.from(payload.split(",")[1]!, "base64");
      const metadata = await sharp(image).metadata();
      expect(metadata).toMatchObject({ format: "png", width: 128, height: 128 });
      expect(image.byteLength).toBeLessThan(256_000);
    }
  });
});
