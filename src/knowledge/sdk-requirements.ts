/**
 * App Store Connect minimum build-tool requirements. Apple announces these at
 * https://developer.apple.com/news/upcoming-requirements/ — re-check there; the
 * table is dated so tools can say how fresh the information is.
 */

export interface SdkRequirement {
  effective: string; // ISO date
  minXcode: string;
  sdks: string;
  source: string;
}

export const SDK_REQUIREMENTS: SdkRequirement[] = [
  {
    effective: "2024-04-29",
    minXcode: "15.0",
    sdks: "iOS 17 / iPadOS 17 / tvOS 17 / watchOS 10 / visionOS 1 SDKs",
    source: "https://developer.apple.com/news/upcoming-requirements/",
  },
  {
    effective: "2025-04-24",
    minXcode: "16.0",
    sdks: "iOS 18 / iPadOS 18 / tvOS 18 / visionOS 2 / watchOS 11 SDKs",
    source: "https://developer.apple.com/news/upcoming-requirements/",
  },
  {
    effective: "2026-04-28",
    minXcode: "26.0",
    sdks: "iOS 26 / iPadOS 26 / tvOS 26 / visionOS 26 / watchOS 26 SDKs",
    source: "https://developer.apple.com/news/upcoming-requirements/",
  },
];

export const SDK_REQUIREMENTS_LAST_REVIEWED = "2026-06-01";

/** Requirement in force on `date` (latest effective <= date). */
export function currentSdkRequirement(date: Date): SdkRequirement | undefined {
  const iso = date.toISOString().slice(0, 10);
  return [...SDK_REQUIREMENTS].reverse().find((r) => r.effective <= iso);
}

/** Notarization (not App Store) only requires binaries linked against the macOS 10.9 SDK or newer. */
export const NOTARIZATION_MIN_SDK = "10.9";
