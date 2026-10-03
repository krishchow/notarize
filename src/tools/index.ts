import { detectProjectTool } from "./detect-project";
import { crashReportsTool, devicesTool, jobsTool, privacyTool, systemLogsTool } from "./diagnostics";
import { doctorTool } from "./doctor";
import { entitlementsTool } from "./entitlements";
import { gatekeeperTool, quarantineTool } from "./gatekeeper";
import { inspectBinaryTool, inspectCodeSignatureTool, signingIdentitiesTool } from "./inspect";
import { provisioningProfilesTool } from "./provisioning";
import type { ToolDef } from "./types";

export const allTools: ToolDef<any>[] = [
  // discovery & diagnostics
  doctorTool,
  detectProjectTool,
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
];
