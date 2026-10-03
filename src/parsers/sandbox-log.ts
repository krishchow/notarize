export interface SandboxViolation {
  process: string;
  pid?: number;
  operation: string;
  target?: string;
  count: number;
  suggestion?: { entitlement?: string; advice: string };
}

const DENY_RE = /Sandbox: ([^(]+)\((\d+)\) deny\(\d+\) (\S+)(?: (.+))?$/;

/** Parse sandbox deny lines from `log show` output and suggest entitlements. */
export function parseSandboxViolations(text: string, home?: string): SandboxViolation[] {
  const map = new Map<string, SandboxViolation>();
  for (const line of text.split("\n")) {
    const m = DENY_RE.exec(line.trim());
    if (!m) continue;
    const [, proc, pid, operation, target] = m;
    const key = `${proc.trim()}|${operation}|${target ?? ""}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    map.set(key, {
      process: proc.trim(),
      pid: Number(pid),
      operation,
      target: target?.trim(),
      count: 1,
      suggestion: suggestForViolation(operation, target?.trim(), home),
    });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function suggestForViolation(
  operation: string,
  target: string | undefined,
  home?: string,
): { entitlement?: string; advice: string } {
  const t = target ?? "";
  const inHome = (sub: string) =>
    (home && t.startsWith(`${home}/${sub}`)) || new RegExp(`^/Users/[^/]+/${sub}(/|$)`).test(t);
  if (operation.startsWith("network-outbound")) {
    return {
      entitlement: "com.apple.security.network.client",
      advice: "Outgoing network connection blocked.",
    };
  }
  if (operation.startsWith("network-bind") || operation.startsWith("network-inbound")) {
    return {
      entitlement: "com.apple.security.network.server",
      advice: "Listening/incoming connection blocked.",
    };
  }
  if (operation.startsWith("file-")) {
    const write = /write|create|unlink|rename/.test(operation);
    if (inHome("Downloads")) {
      return {
        entitlement: "com.apple.security.files.downloads.read-write",
        advice: "Access to ~/Downloads requires the downloads entitlement.",
      };
    }
    for (const [folder, asset] of [
      ["Pictures", "pictures"],
      ["Music", "music"],
      ["Movies", "movies"],
    ] as const) {
      if (inHome(folder)) {
        return {
          entitlement: `com.apple.security.assets.${asset}.${write ? "read-write" : "read-only"}`,
          advice: `Access to ~/${folder} requires the ${asset} assets entitlement.`,
        };
      }
    }
    if (/\/Library\/Containers\//.test(t) || /\/Library\/Group Containers\//.test(t)) {
      return {
        entitlement: "com.apple.security.application-groups",
        advice: "Accessing another container: share data via an App Group both apps declare.",
      };
    }
    return {
      entitlement: write
        ? "com.apple.security.files.user-selected.read-write"
        : "com.apple.security.files.user-selected.read-only",
      advice:
        "Sandboxed apps can only reach arbitrary paths the user chose in an Open/Save panel (or drag-and-drop). Use NSOpenPanel and persist access with security-scoped bookmarks (com.apple.security.files.bookmarks.app-scope). Hard-coded paths outside the container need a temporary exception, which App Review discourages.",
    };
  }
  if (operation.startsWith("appleevent-send")) {
    return {
      entitlement: "com.apple.security.automation.apple-events",
      advice:
        "Sending Apple Events from a sandbox needs com.apple.security.scripting-targets (preferred) or a temporary-exception.apple-events entry, plus NSAppleEventsUsageDescription.",
    };
  }
  if (operation.startsWith("device-camera")) {
    return { entitlement: "com.apple.security.device.camera", advice: "Camera access blocked." };
  }
  if (operation.startsWith("device-microphone")) {
    return { entitlement: "com.apple.security.device.audio-input", advice: "Microphone access blocked." };
  }
  if (operation.startsWith("iokit-open")) {
    if (/USB/i.test(t))
      return { entitlement: "com.apple.security.device.usb", advice: "USB device access blocked." };
    if (/Bluetooth/i.test(t))
      return { entitlement: "com.apple.security.device.bluetooth", advice: "Bluetooth access blocked." };
    if (/Camera|VDC|AVC/i.test(t))
      return { entitlement: "com.apple.security.device.camera", advice: "Camera access blocked." };
    return {
      advice:
        "IOKit user client blocked; usually needs a device entitlement or is not allowed in the sandbox.",
    };
  }
  if (operation.startsWith("mach-lookup")) {
    return {
      advice:
        "Mach service lookup blocked. If it is your own XPC service, embed it in the bundle (XPCServices) or use an App Group-prefixed name; global names need com.apple.security.temporary-exception.mach-lookup.global-name (App Review scrutinizes this).",
    };
  }
  if (operation.startsWith("process-exec")) {
    return {
      advice:
        "Executing a binary outside the bundle is blocked. Bundle helpers inside the app and sign them with app-sandbox + inherit.",
    };
  }
  if (operation.startsWith("user-preference")) {
    return { advice: "Reading another app's preferences is blocked; use App Groups for shared settings." };
  }
  return { advice: "Operation blocked by App Sandbox; review whether it is necessary." };
}
