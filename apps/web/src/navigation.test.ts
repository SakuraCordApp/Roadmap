import { describe, expect, it } from "vitest";
import type { PublicConfig } from "./api.js";
import {
  auditNavigationTargets,
  buildPrimaryNavigation,
  knownBrokenNavigationTargets,
} from "./navigation.js";

const config = {
  project: {
    name: "Fork",
    slug: "fork",
    idPrefix: "FRK",
    description: "A reusable roadmap instance.",
    publicUrl: "https://roadmap.example.test",
    applicationRepository: "/tmp/fork",
    documentationUrl: "https://github.com/example-org/fork/tree/main/docs",
    contributionUrl: "https://github.com/example-org/fork",
  },
} as PublicConfig;

describe("public navigation", () => {
  it("uses a browse anchor instead of a redundant overview self-link", () => {
    const links = buildPrimaryNavigation(config, "overview");
    expect(links[0]).toEqual({ label: "Browse", href: "#browse", external: false });
    expect(links.some((link) => link.href === "/" || link.href === config.project.publicUrl)).toBe(
      false,
    );
  });

  it("returns to the overview browse section from an item detail route", () => {
    expect(buildPrimaryNavigation(config, "detail")[0]?.href).toBe("/#browse");
  });

  it("omits placeholders, self-links, and known broken destinations", () => {
    const broken = {
      ...config,
      project: {
        ...config.project,
        documentationUrl: "https://github.com/SakuraCord/SakuraCord/tree/main/docs",
        contributionUrl: "https://roadmap.example.test",
      },
    };
    const links = buildPrimaryNavigation(broken, "overview");
    expect(links).toHaveLength(1);
    expect([...knownBrokenNavigationTargets]).toContain(
      "https://github.com/SakuraCord/SakuraCord/tree/main/docs",
    );
  });

  it("audits internal and external targets without findings", () => {
    expect(auditNavigationTargets(config, "overview")).toEqual([]);
    expect(auditNavigationTargets(config, "detail")).toEqual([]);
  });
});
