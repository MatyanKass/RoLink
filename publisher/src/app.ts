// Wires the parts together. Tests call this with fakes; index.ts with the real thing.

import { defaultStateDir, loadConfig, makeLog, Redactor, stderrSink } from "./config.js";
import { providersFromEnv } from "./copyright.js";
import { OpenCloud } from "./opencloud.js";
import { Poller } from "./poller.js";
import { Publisher } from "./publisher.js";
import { RoLinkClient } from "./rolink.js";
import { StateStore } from "./store.js";

export interface CreateOptions {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  fetchImpl?: typeof fetch;
  logSink?: (line: string) => void;
}

export function createPublisher(opts: CreateOptions = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const config = loadConfig(env);
  const redactor = new Redactor();
  redactor.add(config.apiKey);
  redactor.add(env.AUDD_API_TOKEN?.trim());
  redactor.add(env.ACRCLOUD_ACCESS_KEY?.trim());
  redactor.add(env.ACRCLOUD_ACCESS_SECRET?.trim());
  const log = makeLog(redactor, opts.logSink ?? stderrSink);

  const store = new StateStore(opts.stateDir ?? defaultStateDir(env));
  const cloud = config.apiKey ? new OpenCloud(config.apiKey, fetchImpl, redactor) : undefined;
  const rolink = new RoLinkClient(Number(env.ROLINK_PORT ?? 34872));
  const poller = new Poller({ store, cloud, rolink, redactor, log });
  const publisher = new Publisher({ config, store, cloud, rolink, poller, providers: providersFromEnv(env, fetchImpl), redactor, log });
  return { publisher, poller, cloud, store, redactor, log, close: () => poller.stop() };
}
