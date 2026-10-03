import { ascApiTool, ascAppsTool, ascBuildsTool } from "./asc-apps";
import {
  ascAuthTool,
  ascBundleIdsTool,
  ascCertificatesTool,
  ascDevicesTool,
  ascProfilesTool,
} from "./asc-signing";
import { distributionChecklistTool } from "./checklist";
import { ciConfigTool } from "./ci";
import { detectProjectTool } from "./detect-project";
import { crashReportsTool, devicesTool, jobsTool, privacyTool, systemLogsTool } from "./diagnostics";
import { doctorTool } from "./doctor";
import { entitlementsTool } from "./entitlements";
import { gatekeeperTool, quarantineTool } from "./gatekeeper";
import { inspectBinaryTool, inspectCodeSignatureTool, signingIdentitiesTool } from "./inspect";
import { keychainTool } from "./keychain";
import { notarizeAndStapleTool, notaryTool, stapleTool } from "./notary";
import { packageTool } from "./package";
import { provisioningProfilesTool } from "./provisioning";
import { resignTool, signTool } from "./signing";
import { appStoreTool, testflightTool } from "./store";
import type { ToolDef } from "./types";
import { uploadBuildTool } from "./upload";
import { xcodeTool } from "./xcode";

export const allTools: ToolDef<any>[] = [
  // discovery & diagnostics
  doctorTool,
  detectProjectTool,
  distributionChecklistTool,
  signingIdentitiesTool,
  inspectCodeSignatureTool,
  inspectBinaryTool,
  entitlementsTool,
  provisioningProfilesTool,
  gatekeeperTool,
  quarantineTool,
  systemLogsTool,
  crashReportsTool,
  privacyTool,
  devicesTool,
  jobsTool,
  // keychain, signing, packaging, notarization
  keychainTool,
  signTool,
  resignTool,
  packageTool,
  notaryTool,
  stapleTool,
  notarizeAndStapleTool,
  // App Store Connect / developer portal
  ascAuthTool,
  ascBundleIdsTool,
  ascCertificatesTool,
  ascDevicesTool,
  ascProfilesTool,
  ascAppsTool,
  ascBuildsTool,
  ascApiTool,
  // build, upload, TestFlight, App Store, CI
  xcodeTool,
  uploadBuildTool,
  testflightTool,
  appStoreTool,
  ciConfigTool,
];
