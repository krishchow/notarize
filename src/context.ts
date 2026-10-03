import { AscTokenProvider } from "./asc/auth";
import { AscClient } from "./asc/client";
import { ConfigStore } from "./core/config";
import { ConfirmManager } from "./core/confirm";
import { type CommandRunner, SpawnRunner } from "./core/exec";
import { JobManager } from "./core/jobs";
import { FileLogWriter } from "./core/logs";
import { detectPlatform, type PlatformInfo } from "./core/platform";
import type { ToolContext } from "./tools/types";

export interface ContextOverrides {
  runner?: CommandRunner;
  platform?: PlatformInfo;
  config?: ConfigStore;
  confirm?: ConfirmManager;
  jobs?: JobManager;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createContext(o: ContextOverrides = {}): ToolContext {
  const platform = o.platform ?? detectPlatform();
  const runner = o.runner ?? new SpawnRunner(new FileLogWriter());
  const config = o.config ?? new ConfigStore(platform.homeDir);
  const fetchFn = o.fetch ?? globalThis.fetch.bind(globalThis);
  const clients = new Map<string, AscClient>();
  return {
    runner,
    platform,
    config,
    confirm: o.confirm ?? new ConfirmManager(),
    jobs: o.jobs ?? new JobManager(),
    fetch: fetchFn,
    now: o.now ?? (() => new Date()),
    async asc(profile?: string) {
      const creds = await config.resolveAsc(profile);
      const cacheKey = `${creds.keyId}:${creds.issuerId ?? "individual"}`;
      let client = clients.get(cacheKey);
      if (!client) {
        client = new AscClient({
          tokens: new AscTokenProvider({
            keyId: creds.keyId,
            issuerId: creds.issuerId,
            privateKeyPem: creds.privateKeyPem,
          }),
          fetch: fetchFn,
        });
        clients.set(cacheKey, client);
      }
      return client;
    },
  };
}
